const express = require('express');
const path = require('path');
const db = require('../db');
const osaa = require('../lib/osaa');
const { sendPhotoRequest } = require('../lib/twilio');
const { triggerCall } = require('../lib/retell');
const { generateArticleForGame } = require('../lib/articles');

const router = express.Router();

router.get('/games', (req, res) => {
  const { school_id, sport_id, status, date_from, date_to } = req.query;
  const where = [];
  const params = [];
  if (school_id) { where.push('s.id = ?'); params.push(parseInt(school_id, 10)); }
  if (sport_id) { where.push('sp.id = ?'); params.push(parseInt(sport_id, 10)); }
  if (status) { where.push('g.status = ?'); params.push(status); }
  if (date_from) { where.push('g.game_date >= ?'); params.push(date_from); }
  if (date_to) { where.push('g.game_date <= ?'); params.push(date_to); }

  const games = db.prepare(`
    SELECT g.*, sp.name AS sport_name, s.name AS school_name, t.level,
      (SELECT COUNT(*) FROM photos p WHERE p.game_id = g.id) AS photo_count,
      (SELECT COUNT(*) FROM calls c WHERE c.game_id = g.id) AS call_count,
      (SELECT id FROM articles a WHERE a.game_id = g.id ORDER BY a.created_at DESC LIMIT 1) AS article_id
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY g.game_date DESC, g.game_time
    LIMIT 200
  `).all(...params);

  const schools = db.prepare('SELECT * FROM schools ORDER BY name').all();
  const sports = db.prepare('SELECT * FROM sports ORDER BY name').all();
  const teams = db.prepare(`
    SELECT t.id, t.level, s.name AS school_name, sp.name AS sport_name
    FROM teams t
    JOIN schools s ON s.id = t.school_id
    JOIN sports sp ON sp.id = t.sport_id
    WHERE t.is_active = 1
    ORDER BY s.name, sp.name
  `).all();

  res.render('pages/games', {
    title: 'Games',
    games, schools, sports, teams,
    filters: { school_id, sport_id, status, date_from, date_to },
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.post('/games', (req, res) => {
  const { team_id, opponent, game_date, game_time, status, location } = req.body;
  if (!team_id || !game_date) {
    req.session.flash = { type: 'error', message: 'Team and game date are required.' };
    return res.redirect('/games');
  }
  try {
    db.prepare(`
      INSERT INTO games (team_id, opponent, location, game_date, game_time, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      parseInt(team_id, 10),
      opponent || null,
      location || null,
      game_date,
      game_time || null,
      status || 'upcoming'
    );
    req.session.flash = { type: 'success', message: 'Game added.' };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect('/games');
});

router.get('/games/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const game = db.prepare(`
    SELECT g.*, sp.name AS sport_name, sp.osaa_slug AS sport_slug, s.name AS school_name, t.level
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE g.id = ?
  `).get(id);
  if (!game) return res.status(404).render('pages/error', { title: 'Not found', message: 'Game not found.', user: req.user });

  const photos = db.prepare('SELECT * FROM photos WHERE game_id = ? ORDER BY received_at').all(id);
  const calls = db.prepare(`
    SELECT c.*, ct.name AS contact_name FROM calls c
    LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.game_id = ? ORDER BY c.created_at
  `).all(id);
  const texts = db.prepare(`
    SELECT gt.*, ct.name AS contact_name FROM game_texts gt
    LEFT JOIN contacts ct ON ct.id = gt.contact_id WHERE gt.game_id = ? ORDER BY gt.received_at
  `).all(id);
  const articles = db.prepare('SELECT * FROM articles WHERE game_id = ? ORDER BY created_at DESC').all(id);
  const events = db.prepare(`SELECT * FROM notification_log WHERE related_game_id = ? ORDER BY created_at DESC LIMIT 50`).all(id);
  const contact = db.prepare(`SELECT * FROM contacts WHERE team_id = ? AND is_primary = 1 AND is_active = 1 LIMIT 1`).get(game.team_id);
  const teamContacts = db.prepare(`SELECT * FROM contacts WHERE team_id = ? AND is_active = 1 AND phone IS NOT NULL ORDER BY is_primary DESC, name`).all(game.team_id);

  res.render('pages/game-detail', {
    title: `${game.school_name} ${game.sport_name}`,
    game, photos, calls, texts, articles, events, contact, teamContacts,
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.post('/games/:id/sync', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const game = db.prepare('SELECT team_id FROM games WHERE id = ?').get(id);
  if (!game) return res.redirect('/games');
  try {
    const r = await osaa.syncTeamSchedule(game.team_id);
    req.session.flash = { type: 'success', message: `OSAA sync: +${r.added}, updated ${r.updated}${r.error ? ` (error: ${r.error})` : ''}` };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect(`/games/${id}`);
});

router.post('/games/:id/send-photo-request', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await sendPhotoRequest(id);
    req.session.flash = r.skipped ? { type: 'error', message: r.skipped } : { type: 'success', message: 'Photo request sent.' };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect(`/games/${id}`);
});

router.post('/games/:id/trigger-call', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const contactId = req.body.contact_id ? parseInt(req.body.contact_id, 10) : null;
  try {
    const r = await triggerCall(id, { manual: true, contactId });
    req.session.flash = r.skipped ? { type: 'error', message: r.skipped } : { type: 'success', message: 'Call initiated.' };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect(`/games/${id}`);
});

router.post('/games/:id/generate-article', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await generateArticleForGame(id);
    req.session.flash = r.skipped ? { type: 'error', message: r.skipped } : { type: 'success', message: 'Article generated.' };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect(`/games/${id}`);
});

// Serve uploaded photo file
router.get('/photos/:id/file', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!photo) return res.status(404).send('Not found');
  res.sendFile(path.resolve(photo.file_path));
});

module.exports = router;
