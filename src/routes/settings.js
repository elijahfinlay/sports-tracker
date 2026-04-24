const express = require('express');
const settings = require('../lib/settings');
const apiTokens = require('../lib/api-tokens');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All settings views are admin-only.
router.use(requireAdmin);

router.get('/', (req, res) => {
  const values = settings.getAll();
  // For secret fields, only show whether they're set (never the value)
  const secretStatus = {};
  for (const [key, meta] of Object.entries(settings.SCHEMA)) {
    if (meta.secret) secretStatus[key] = settings.isSecretSet(key);
  }
  // Pretty-print JSON settings for the textarea
  let sportDurations = values.sport_game_durations;
  try { sportDurations = JSON.stringify(JSON.parse(sportDurations), null, 2); } catch {}

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get().c;

  res.render('pages/settings', {
    title: 'Settings',
    values: { ...values, sport_game_durations: sportDurations },
    secretStatus,
    flash: req.session.flash || null,
    userCount,
  });
  delete req.session.flash;
});

router.post('/', (req, res) => {
  const fields = [
    'outlet_name',
    'photo_text_offset_minutes', 'call_offset_minutes',
    'sport_game_durations',
    'photo_request_template', 'text_only_recap_template', 'text_only_nudge_template', 'intro_text_template',
    'reply_photo_received', 'reply_text_received', 'reply_both_received',
    'journalism_prompt',
  ];

  // Validate the JSON one before writing anything
  if (req.body.sport_game_durations) {
    try { JSON.parse(req.body.sport_game_durations); }
    catch (e) {
      req.session.flash = { type: 'error', message: 'Sport durations must be valid JSON.' };
      return res.redirect('/settings');
    }
  }

  for (const f of fields) {
    if (req.body[f] !== undefined) settings.set(f, req.body[f]);
  }

  req.session.flash = { type: 'success', message: 'Settings saved.' };
  res.redirect('/settings');
});

router.post('/secrets', (req, res) => {
  // Only update secret fields the operator actually filled in (blank means leave alone).
  // Use a special sentinel "__clear__" to delete a secret.
  const secretFields = Object.entries(settings.SCHEMA).filter(([, m]) => m.secret).map(([k]) => k);
  for (const f of secretFields) {
    const v = req.body[f];
    if (v === undefined || v === '') continue;
    if (v === '__clear__') settings.set(f, '');
    else settings.set(f, v);
  }
  req.session.flash = { type: 'success', message: 'API credentials updated.' };
  res.redirect('/settings');
});

// API tokens

router.get('/tokens', (req, res) => {
  res.render('pages/api-tokens', {
    title: 'API tokens',
    tokens: apiTokens.list(),
    newToken: req.session.newToken || null,
    flash: req.session.flash || null,
  });
  delete req.session.flash;
  delete req.session.newToken;
});

router.post('/tokens', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) { req.session.flash = { type: 'error', message: 'Name required.' }; return res.redirect('/settings/tokens'); }
  const { token } = apiTokens.create(name);
  req.session.newToken = token;
  req.session.flash = { type: 'success', message: `Token "${name}" created.` };
  res.redirect('/settings/tokens');
});

router.post('/tokens/:id/revoke', (req, res) => {
  apiTokens.revoke(parseInt(req.params.id, 10));
  req.session.flash = { type: 'success', message: 'Token revoked.' };
  res.redirect('/settings/tokens');
});

module.exports = router;
