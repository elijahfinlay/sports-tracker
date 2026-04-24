const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const stats = {
    todayGames: db.prepare(`SELECT COUNT(*) AS c FROM games WHERE game_date = ? AND status != 'cancelled'`).get(today).c,
    activeSchools: db.prepare(`SELECT COUNT(*) AS c FROM schools WHERE is_active = 1`).get().c,
    pendingArticles: db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE status = 'pending_review'`).get().c,
    recentPhotos: db.prepare(`SELECT COUNT(*) AS c FROM photos WHERE received_at >= datetime('now','-1 day')`).get().c,
    activeContacts: db.prepare(`SELECT COUNT(*) AS c FROM contacts WHERE is_active = 1`).get().c,
  };

  const todayGames = db.prepare(`
    SELECT g.id, g.game_time, g.opponent, g.status,
           s.name AS school_name, sp.name AS sport_name
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN schools s ON s.id = t.school_id
    JOIN sports sp ON sp.id = t.sport_id
    WHERE g.game_date = ? AND g.status != 'cancelled'
    ORDER BY g.game_time
  `).all(today);

  const recentActivity = db.prepare(`
    SELECT type, message, created_at FROM notification_log
    WHERE created_at >= datetime('now','-1 day')
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  res.render('pages/dashboard', { title: 'Dashboard', stats, todayGames, recentActivity });
});

module.exports = router;
