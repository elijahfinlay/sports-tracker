const express = require('express');
const db = require('../db');
const { logEvent } = require('../lib/log');

const router = express.Router();

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (raw.startsWith('+')) return raw.trim();
  return '+' + digits;
}

router.get('/contacts', (req, res) => {
  const schoolFilter = req.query.school_id ? parseInt(req.query.school_id, 10) : null;
  const teamFilter = req.query.team_id ? parseInt(req.query.team_id, 10) : null;
  const showInactive = req.query.show_inactive === '1';

  const params = [];
  const where = [];
  if (!showInactive) where.push('c.is_active = 1');
  if (schoolFilter) { where.push('s.id = ?'); params.push(schoolFilter); }
  if (teamFilter) { where.push('t.id = ?'); params.push(teamFilter); }

  const contacts = db.prepare(`
    SELECT c.*, t.level, sp.name AS sport_name, s.name AS school_name, s.id AS school_id
    FROM contacts c
    JOIN teams t ON t.id = c.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.name, sp.name, t.level, c.is_primary DESC, c.name
  `).all(...params);

  const schools = db.prepare('SELECT * FROM schools ORDER BY name').all();
  const teams = db.prepare(`
    SELECT t.id, t.level, sp.name AS sport_name, s.name AS school_name, s.id AS school_id
    FROM teams t JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    WHERE t.is_active = 1
    ORDER BY s.name, sp.name, t.level
  `).all();

  res.render('pages/contacts', {
    title: 'Contacts',
    contacts, schools, teams,
    filters: { school_id: schoolFilter, team_id: teamFilter, show_inactive: showInactive },
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.post('/contacts', (req, res) => {
  const { team_id, name, role, phone, email, preference, is_primary } = req.body;
  if (!team_id || !name) { req.session.flash = { type: 'error', message: 'Team and name required.' }; return res.redirect('/contacts'); }
  const phoneNorm = normalizePhone(phone);
  db.prepare(`
    INSERT INTO contacts (team_id, name, role, phone, email, preference, is_primary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(parseInt(team_id, 10), name.trim(), role || null, phoneNorm, email || null, preference || 'call', is_primary ? 1 : 0);
  req.session.flash = { type: 'success', message: `Added ${name}.` };
  res.redirect('/contacts');
});

router.post('/contacts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, role, phone, email, preference, is_primary } = req.body;
  const phoneNorm = normalizePhone(phone);
  db.prepare(`
    UPDATE contacts SET name = ?, role = ?, phone = ?, email = ?, preference = ?, is_primary = ?
    WHERE id = ?
  `).run(name?.trim() || '', role || null, phoneNorm, email || null, preference || 'call', is_primary ? 1 : 0, id);
  req.session.flash = { type: 'success', message: 'Contact updated.' };
  res.redirect('/contacts');
});

router.post('/contacts/:id/toggle', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT is_active FROM contacts WHERE id = ?').get(id);
  if (!c) { req.session.flash = { type: 'error', message: 'Contact not found.' }; return res.redirect('/contacts'); }
  db.prepare('UPDATE contacts SET is_active = ? WHERE id = ?').run(c.is_active ? 0 : 1, id);
  res.redirect('/contacts');
});

router.post('/contacts/:id/preference', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { preference } = req.body;
  if (!['call', 'text_only'].includes(preference)) {
    req.session.flash = { type: 'error', message: 'Invalid preference.' }; return res.redirect('/contacts');
  }
  db.prepare('UPDATE contacts SET preference = ? WHERE id = ?').run(preference, id);
  res.redirect('/contacts');
});

router.post('/contacts/:id/intro', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { sendIntroText } = require('../lib/twilio');
  try {
    const result = await sendIntroText(id);
    if (result.skipped) {
      req.session.flash = { type: 'error', message: result.skipped };
    } else {
      req.session.flash = { type: 'success', message: `Intro text sent to ${result.contact.name}.` };
    }
  } catch (e) {
    req.session.flash = { type: 'error', message: `Intro send failed: ${e.message}` };
  }
  res.redirect('/contacts');
});

// CSV import: paste lines of "school,sport,level,name,role,phone,email,preference"
router.post('/contacts/import', (req, res) => {
  const csv = (req.body.csv || '').trim();
  if (!csv) { req.session.flash = { type: 'error', message: 'Paste CSV rows first.' }; return res.redirect('/contacts'); }

  const rows = csv.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  let added = 0, skipped = 0;
  const errors = [];

  const schools = new Map(db.prepare('SELECT id, name FROM schools').all().map(s => [s.name.toLowerCase(), s.id]));
  const sports = db.prepare('SELECT id, name, osaa_slug FROM sports').all();

  for (const line of rows) {
    const cols = line.split(',').map(s => s.trim());
    const [schoolName, sportName, level, name, role, phone, email, preference] = cols;
    if (!schoolName || !sportName || !name) { skipped++; errors.push(`Skip "${line}": missing required fields`); continue; }
    const schoolId = schools.get(schoolName.toLowerCase());
    if (!schoolId) { skipped++; errors.push(`Skip "${line}": school not found`); continue; }
    const sport = sports.find(s => s.name.toLowerCase() === sportName.toLowerCase() || s.osaa_slug === sportName.toLowerCase());
    if (!sport) { skipped++; errors.push(`Skip "${line}": sport not found`); continue; }
    const lvl = (level || 'V').toUpperCase();
    const team = db.prepare('SELECT id FROM teams WHERE school_id = ? AND sport_id = ? AND level = ?').get(schoolId, sport.id, lvl);
    if (!team) { skipped++; errors.push(`Skip "${line}": no ${schoolName} ${sportName} ${lvl} team — add it first`); continue; }

    db.prepare(`INSERT INTO contacts (team_id, name, role, phone, email, preference, is_primary)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(team.id, name, role || null, normalizePhone(phone), email || null, preference || 'call', 1);
    added++;
  }
  req.session.flash = {
    type: skipped ? 'error' : 'success',
    message: `Imported ${added} · skipped ${skipped}${errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''}`,
  };
  res.redirect('/contacts');
});

module.exports = router;
