const express = require('express');
const path = require('path');
const db = require('../db');
const tokens = require('../lib/api-tokens');

const router = express.Router();

// Bearer-token auth for all /api routes (except health)
router.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.header('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
  const t = tokens.verify(m[1].trim());
  if (!t) return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Token not recognized' } });
  req.apiToken = t;
  next();
});

function paginate(req, defaults = { limit: 20, max: 100 }) {
  const limit = Math.min(parseInt(req.query.limit || defaults.limit, 10) || defaults.limit, defaults.max);
  const offset = parseInt(req.query.offset || '0', 10) || 0;
  return { limit, offset };
}

function articleToJSON(a) {
  return {
    id: a.id,
    headline: a.headline,
    body: a.body,
    status: a.status,
    source: a.source,
    thin_source: !!a.thin_source,
    photo_url: a.photo_id ? `/api/photos/${a.photo_id}/file` : null,
    game: {
      id: a.game_id,
      date: a.game_date,
      sport: a.sport_name,
      school: a.school_name,
      opponent: a.opponent,
      result: a.result,
    },
    published_at: a.published_at,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

router.get('/health', (_req, res) => {
  const lastSync = db.prepare(`SELECT created_at FROM notification_log WHERE type = 'osaa_sync' ORDER BY created_at DESC LIMIT 1`).get();
  res.json({
    status: 'ok',
    last_osaa_sync: lastSync ? lastSync.created_at : null,
    pending_articles: db.prepare(`SELECT COUNT(*) AS c FROM articles WHERE status = 'pending_review'`).get().c,
    upcoming_games: db.prepare(`SELECT COUNT(*) AS c FROM games WHERE game_date >= date('now') AND status != 'cancelled'`).get().c,
  });
});

router.get('/articles', (req, res) => {
  const { limit, offset } = paginate(req);
  const where = ["a.status IN ('approved','published')"];
  const params = [];
  if (req.query.status) {
    where[0] = 'a.status = ?'; params.push(req.query.status);
  }
  if (req.query.school) { where.push('s.name = ?'); params.push(req.query.school); }
  if (req.query.sport) { where.push('sp.name = ?'); params.push(req.query.sport); }
  if (req.query.since) { where.push('a.updated_at >= ?'); params.push(req.query.since); }

  const rows = db.prepare(`
    SELECT a.*, g.id AS game_id, g.game_date, g.opponent, g.result,
      sp.name AS sport_name, s.name AS school_name
    FROM articles a
    JOIN games g ON g.id = a.game_id
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM articles a
    JOIN games g ON g.id = a.game_id JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    WHERE ${where.join(' AND ')}
  `).get(...params).c;

  res.json({ data: rows.map(articleToJSON), meta: { total, limit, offset } });
});

router.get('/articles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = db.prepare(`
    SELECT a.*, g.id AS game_id, g.game_date, g.opponent, g.result,
      sp.name AS sport_name, s.name AS school_name
    FROM articles a JOIN games g ON g.id = a.game_id
    JOIN teams t ON t.id = g.team_id JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    WHERE a.id = ? AND a.status IN ('approved','published')
  `).get(id);
  if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Article not found' } });
  res.json({ data: articleToJSON(a) });
});

router.patch('/articles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  if (!['approved', 'published'].includes(status)) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'status must be "approved" or "published"' } });
  }
  const a = db.prepare(`SELECT * FROM articles WHERE id = ? AND status IN ('approved','published')`).get(id);
  if (!a) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Article not found' } });
  if (status === 'published') {
    db.prepare(`UPDATE articles SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  } else {
    db.prepare(`UPDATE articles SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
  }
  res.json({ data: { id, status } });
});

router.get('/games', (req, res) => {
  const { limit, offset } = paginate(req);
  const where = [];
  const params = [];
  if (req.query.school) { where.push('s.name = ?'); params.push(req.query.school); }
  if (req.query.sport) { where.push('sp.name = ?'); params.push(req.query.sport); }
  if (req.query.status) { where.push('g.status = ?'); params.push(req.query.status); }
  if (req.query.date_from) { where.push('g.game_date >= ?'); params.push(req.query.date_from); }
  if (req.query.date_to) { where.push('g.game_date <= ?'); params.push(req.query.date_to); }

  const rows = db.prepare(`
    SELECT g.*, sp.name AS sport_name, s.name AS school_name, t.level
    FROM games g JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY g.game_date DESC, g.game_time
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) AS c FROM games g
    JOIN teams t ON t.id = g.team_id JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params).c;

  res.json({
    data: rows.map(g => ({
      id: g.id, date: g.game_date, time: g.game_time, status: g.status,
      school: g.school_name, sport: g.sport_name, level: g.level,
      opponent: g.opponent, location: g.location, result: g.result,
    })),
    meta: { total, limit, offset },
  });
});

router.get('/games/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const g = db.prepare(`
    SELECT g.*, sp.name AS sport_name, s.name AS school_name, t.level
    FROM games g JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    WHERE g.id = ?
  `).get(id);
  if (!g) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Game not found' } });
  const photos = db.prepare('SELECT id, mime_type, received_at FROM photos WHERE game_id = ? ORDER BY received_at').all(id);
  const article = db.prepare(`SELECT id, headline, status FROM articles WHERE game_id = ? AND status IN ('approved','published') ORDER BY updated_at DESC LIMIT 1`).get(id);
  res.json({
    data: {
      id: g.id, date: g.game_date, time: g.game_time, status: g.status,
      school: g.school_name, sport: g.sport_name, level: g.level,
      opponent: g.opponent, location: g.location, result: g.result,
      photos: photos.map(p => ({ id: p.id, url: `/api/photos/${p.id}/file`, mime_type: p.mime_type, received_at: p.received_at })),
      article: article ? { id: article.id, headline: article.headline, status: article.status, url: `/api/articles/${article.id}` } : null,
    },
  });
});

router.get('/photos/:id/file', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
  if (!photo) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });
  res.sendFile(path.resolve(photo.file_path));
});

router.get('/games/:id/photos', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photos = db.prepare('SELECT id, mime_type, received_at FROM photos WHERE game_id = ?').all(id);
  res.json({ data: photos.map(p => ({ id: p.id, url: `/api/photos/${p.id}/file`, mime_type: p.mime_type, received_at: p.received_at })) });
});

router.get('/schools', (_req, res) => {
  const data = db.prepare('SELECT id, osaa_id, name, classification, mascot FROM schools WHERE is_active = 1 ORDER BY name').all();
  res.json({ data });
});

router.get('/schools/:id/teams', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const teams = db.prepare(`
    SELECT t.id, sp.name AS sport, sp.osaa_slug, t.level
    FROM teams t JOIN sports sp ON sp.id = t.sport_id
    WHERE t.school_id = ? AND t.is_active = 1
    ORDER BY sp.season, sp.name
  `).all(id);
  res.json({ data: teams });
});

router.get('/schedule', (req, res) => {
  const date_from = req.query.date_from || new Date().toISOString().slice(0, 10);
  const date_to = req.query.date_to || null;
  const params = [date_from];
  let where = 'g.game_date >= ?';
  if (date_to) { where += ' AND g.game_date <= ?'; params.push(date_to); }
  const rows = db.prepare(`
    SELECT g.id, g.game_date AS date, g.game_time AS time, g.status, g.opponent, g.location,
      sp.name AS sport, s.name AS school, t.level
    FROM games g JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id JOIN schools s ON s.id = t.school_id
    WHERE ${where} AND g.status != 'cancelled'
    ORDER BY g.game_date, g.game_time
  `).all(...params);
  res.json({ data: rows });
});

module.exports = router;
