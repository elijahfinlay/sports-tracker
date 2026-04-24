const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/activity', (req, res) => {
  const type = req.query.type || '';
  const date_from = req.query.date_from || '';
  const date_to = req.query.date_to || '';

  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (date_from) { where.push('created_at >= ?'); params.push(date_from); }
  if (date_to) { where.push('created_at <= ?'); params.push(date_to + ' 23:59:59'); }

  const events = db.prepare(`
    SELECT * FROM notification_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT 500
  `).all(...params);

  const types = db.prepare(`SELECT DISTINCT type FROM notification_log ORDER BY type`).all().map(r => r.type);

  res.render('pages/activity', {
    title: 'Activity Log',
    events, types,
    filters: { type, date_from, date_to },
  });
});

module.exports = router;
