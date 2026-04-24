const db = require('../db');
const { encrypt, decrypt } = require('./crypto');

// Default values + secret flag for each known setting
const SCHEMA = {
  // Timing
  photo_text_offset_minutes: { default: -30, secret: false, type: 'number' },
  call_offset_minutes: { default: 45, secret: false, type: 'number' },

  // Sport game-duration estimates (minutes) — keyed by sport slug
  sport_game_durations: { default: JSON.stringify({
    fbl: 180, bbx: 120, gbx: 120, vbl: 120, sbl: 150, bbl: 150, scb: 120, scg: 120,
    swm: 120, wre: 240, gol: 180, gob: 180, ten: 180, lab: 150, lag: 150, txc: 120, twc: 120, tfb: 240, tfg: 240,
  }), secret: false, type: 'json' },

  // Templates
  photo_request_template: { default: "Hi {coach_name}, it's {outlet_name}! {team} plays {opponent} today. Can you send us a game photo when you get a chance? You can also text us the score and any highlights after the game. Just reply to this number. Thanks!", secret: false, type: 'text' },
  text_only_recap_template: { default: "Hey Coach {coach_name}! Quick recap for the {opponent} game:\n1. Final score?\n2. Any standout players or big moments?\n3. Where does this put you in the season?\n4. Big games coming up?\nReply here and we'll write it up. Thanks!", secret: false, type: 'text' },
  text_only_nudge_template: { default: "No worries if you're busy Coach — just the score is helpful if you get a sec!", secret: false, type: 'text' },
  intro_text_template: { default: "Hi {coach_name}, this is {outlet_name}! We're covering {school} {sport} this season. On game days, we'll text you asking for a quick photo. After the game, we may call for a brief recap — or if you prefer, you can just text us the score and highlights instead. You can always text photos or game info to this number anytime. Reply STOP to opt out. Thanks for helping us cover the team!", secret: false, type: 'text' },
  reply_photo_received: { default: "Got it, thanks Coach!", secret: false, type: 'text' },
  reply_text_received: { default: "Got it, thanks Coach! We'll use this for the recap.", secret: false, type: 'text' },
  reply_both_received: { default: "Got the photo and the info, thanks Coach!", secret: false, type: 'text' },

  // Outlet identity (used in templates)
  outlet_name: { default: 'Roseburg Sports', secret: false, type: 'text' },

  // Journalism prompt for Claude
  journalism_prompt: { default: '', secret: false, type: 'text' },

  // API credentials (encrypted at rest — operator can paste here instead of editing .env)
  twilio_account_sid: { default: '', secret: true, type: 'text' },
  twilio_auth_token: { default: '', secret: true, type: 'text' },
  twilio_phone_number: { default: '', secret: true, type: 'text' },
  retell_api_key: { default: '', secret: true, type: 'text' },
  retell_agent_id: { default: '', secret: true, type: 'text' },
  anthropic_api_key: { default: '', secret: true, type: 'text' },
};

function get(key) {
  const def = SCHEMA[key];
  const row = db.prepare('SELECT value, is_secret FROM settings WHERE key = ?').get(key);
  if (!row) return def ? def.default : null;
  if (row.is_secret) return decrypt(row.value);
  return row.value;
}

function getNumber(key) {
  const v = get(key);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : (SCHEMA[key]?.default ?? 0);
}

function getJSON(key) {
  try { return JSON.parse(get(key)); } catch { return SCHEMA[key]?.default ? JSON.parse(SCHEMA[key].default) : {}; }
}

function set(key, value) {
  const def = SCHEMA[key];
  const isSecret = def ? def.secret : false;
  const stored = isSecret ? encrypt(value || '') : (value ?? '');
  const existing = db.prepare('SELECT id FROM settings WHERE key = ?').get(key);
  if (existing) {
    db.prepare(`UPDATE settings SET value = ?, is_secret = ?, updated_at = datetime('now') WHERE key = ?`).run(stored, isSecret ? 1 : 0, key);
  } else {
    db.prepare(`INSERT INTO settings (key, value, is_secret) VALUES (?, ?, ?)`).run(key, stored, isSecret ? 1 : 0);
  }
}

function getAll() {
  const out = {};
  for (const key of Object.keys(SCHEMA)) {
    out[key] = get(key);
  }
  return out;
}

function isSecretSet(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return !!(row && row.value);
}

module.exports = { SCHEMA, get, getNumber, getJSON, set, getAll, isSecretSet };
