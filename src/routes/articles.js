const express = require('express');
const db = require('../db');
const { logEvent } = require('../lib/log');

const router = express.Router();

router.get('/articles', (req, res) => {
  const status = req.query.status || '';
  const where = [];
  const params = [];
  if (status) { where.push('a.status = ?'); params.push(status); }

  // Order: pending_review first, then approved, then published, then rejected
  const articles = db.prepare(`
    SELECT a.*, g.game_date, g.opponent, g.result,
      sp.name AS sport_name, s.name AS school_name,
      (SELECT COUNT(*) FROM photos p WHERE p.game_id = g.id) AS photo_count
    FROM articles a
    JOIN games g ON g.id = a.game_id
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE a.status WHEN 'pending_review' THEN 1 WHEN 'approved' THEN 2 WHEN 'published' THEN 3 WHEN 'rejected' THEN 4 ELSE 5 END,
      a.created_at DESC
    LIMIT 200
  `).all(...params);

  const counts = db.prepare(`SELECT status, COUNT(*) AS c FROM articles GROUP BY status`).all()
    .reduce((a, r) => { a[r.status] = r.c; return a; }, {});

  res.render('pages/articles', {
    title: 'Articles', articles, counts, status,
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.get('/articles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const article = db.prepare(`
    SELECT a.*, g.game_date, g.opponent, g.result, g.id AS game_id,
      sp.name AS sport_name, s.name AS school_name
    FROM articles a
    JOIN games g ON g.id = a.game_id
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE a.id = ?
  `).get(id);
  if (!article) return res.status(404).render('pages/error', { title: 'Not found', message: 'Article not found.', user: req.user });

  const photos = db.prepare('SELECT * FROM photos WHERE game_id = ? ORDER BY received_at').all(article.game_id);

  res.render('pages/article-detail', {
    title: article.headline,
    article, photos,
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.post('/articles/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { headline, body, photo_id } = req.body;
  db.prepare(`UPDATE articles SET headline = ?, body = ?, photo_id = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(headline, body, photo_id ? parseInt(photo_id, 10) : null, id);
  req.session.flash = { type: 'success', message: 'Article updated.' };
  res.redirect(`/articles/${id}`);
});

router.post('/articles/:id/approve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`UPDATE articles SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(req.session.userId, id);
  logEvent('article_approved', `Article ${id} approved by ${req.session.username}`);
  req.session.flash = { type: 'success', message: 'Article approved — now available via API.' };
  res.redirect(`/articles/${id}`);
});

router.post('/articles/:id/reject', (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare(`UPDATE articles SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(req.session.userId, id);
  logEvent('article_rejected', `Article ${id} rejected by ${req.session.username}`);
  req.session.flash = { type: 'success', message: 'Article rejected.' };
  res.redirect(`/articles/${id}`);
});

router.post('/articles/:id/regenerate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const a = db.prepare('SELECT game_id FROM articles WHERE id = ?').get(id);
  if (!a) { req.session.flash = { type: 'error', message: 'Article not found.' }; return res.redirect('/articles'); }
  try {
    const { generateArticleForGame } = require('../lib/articles');
    const r = await generateArticleForGame(a.game_id);
    if (r.skipped) req.session.flash = { type: 'error', message: r.skipped };
    else req.session.flash = { type: 'success', message: 'New draft generated.' };
    res.redirect(r.article_id ? `/articles/${r.article_id}` : `/articles/${id}`);
  } catch (e) {
    req.session.flash = { type: 'error', message: e.message };
    res.redirect(`/articles/${id}`);
  }
});

module.exports = router;
