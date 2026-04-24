const express = require('express');
const db = require('../db');
const osaa = require('../lib/osaa');
const { logEvent } = require('../lib/log');

const router = express.Router();

router.get('/teams', (req, res) => {
  const schools = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM teams t WHERE t.school_id = s.id) AS team_count,
      (SELECT COUNT(*) FROM teams t WHERE t.school_id = s.id AND t.is_active = 1) AS active_team_count
    FROM schools s
    ORDER BY s.name
  `).all();

  const teams = db.prepare(`
    SELECT t.*, sp.name AS sport_name, sp.season, sp.osaa_slug, s.name AS school_name,
      (SELECT COUNT(*) FROM contacts c WHERE c.team_id = t.id AND c.is_active = 1) AS contact_count
    FROM teams t
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    ORDER BY s.name, sp.season, sp.name, t.level
  `).all();

  const teamsBySchool = {};
  for (const t of teams) {
    (teamsBySchool[t.school_id] ||= []).push(t);
  }

  const sports = db.prepare('SELECT id, name, season FROM sports ORDER BY season, name').all();

  res.render('pages/teams', {
    title: 'Schools & Teams',
    schools, teamsBySchool, sports,
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.post('/teams/sync', async (req, res) => {
  const summaries = [];
  const schools = db.prepare('SELECT id, name FROM schools WHERE is_active = 1').all();
  for (const s of schools) {
    try {
      const r = await osaa.syncSchoolTeams(s.id);
      summaries.push(`${s.name}: +${r.added}, updated ${r.updated}${r.error ? ` (error: ${r.error})` : ''}`);
    } catch (e) {
      summaries.push(`${s.name}: failed (${e.message})`);
    }
  }
  req.session.flash = { type: 'success', message: 'OSAA sync attempted. ' + summaries.join(' | ') };
  res.redirect('/teams');
});

router.post('/teams/:id/toggle', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const team = db.prepare('SELECT id, is_active FROM teams WHERE id = ?').get(id);
  if (!team) { req.session.flash = { type: 'error', message: 'Team not found.' }; return res.redirect('/teams'); }
  db.prepare('UPDATE teams SET is_active = ? WHERE id = ?').run(team.is_active ? 0 : 1, id);
  res.redirect('/teams');
});

router.post('/teams', (req, res) => {
  const { school_id, sport_id, level } = req.body;
  if (!school_id || !sport_id) { req.session.flash = { type: 'error', message: 'School and sport required.' }; return res.redirect('/teams'); }
  try {
    osaa.upsertTeam({ schoolId: parseInt(school_id, 10), sportId: parseInt(sport_id, 10), level: level || 'V', osaaTeamId: null });
    req.session.flash = { type: 'success', message: 'Team added.' };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect('/teams');
});

router.post('/teams/:id/scrape-coaches', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const r = await osaa.syncTeamCoaches(id);
    req.session.flash = { type: 'success', message: `Coach scrape: +${r.added}${r.error ? ` (error: ${r.error})` : ''}` };
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
  }
  res.redirect('/teams');
});

module.exports = router;
