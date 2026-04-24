const path = require('path');
const fs = require('fs');
const db = require('../db');
const settings = require('./settings');
const { logEvent } = require('./log');

let _client = null;
function getClient() {
  if (_client) return _client;
  const sid = settings.get('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID;
  const token = settings.get('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  _client = twilio(sid, token);
  return _client;
}

function getFromNumber() {
  return settings.get('twilio_phone_number') || process.env.TWILIO_PHONE_NUMBER;
}

function fillTemplate(tpl, vars) {
  return (tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

async function sendSMS(to, body) {
  const client = getClient();
  const from = getFromNumber();
  if (!client || !from) {
    return { skipped: 'Twilio not configured (set credentials in Settings).' };
  }
  if (!to) return { skipped: 'No phone number on file.' };
  const message = await client.messages.create({ from, to, body });
  return { sid: message.sid };
}

// Send the photo-request SMS for a game.
async function sendPhotoRequest(gameId) {
  const game = db.prepare(`
    SELECT g.*, t.id AS team_id, sp.name AS sport_name, s.name AS school_name
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE g.id = ?
  `).get(gameId);
  if (!game) throw new Error(`Game ${gameId} not found`);
  if (game.photo_requested) return { skipped: 'Already sent.' };

  const contact = db.prepare(`
    SELECT * FROM contacts WHERE team_id = ? AND is_primary = 1 AND is_active = 1
    ORDER BY id LIMIT 1
  `).get(game.team_id);
  if (!contact) return { skipped: 'No primary contact for team.' };
  if (!contact.phone) return { skipped: `${contact.name} has no phone.` };

  const body = fillTemplate(settings.get('photo_request_template'), {
    coach_name: contact.name.split(' ')[0],
    outlet_name: settings.get('outlet_name'),
    team: `${game.school_name} ${game.sport_name}`,
    school: game.school_name,
    sport: game.sport_name,
    opponent: game.opponent || 'their opponent',
  });

  const r = await sendSMS(contact.phone, body);
  if (r.skipped) {
    logEvent('error', `Photo request skipped for game ${gameId}: ${r.skipped}`, gameId);
    return r;
  }
  db.prepare(`UPDATE games SET photo_requested = 1, photo_request_sent_at = datetime('now') WHERE id = ?`).run(gameId);
  logEvent('sms_sent', `Photo request to ${contact.name} (${contact.phone}) for game ${gameId}`, gameId);
  return r;
}

// Send the structured text-only recap question SMS.
async function sendTextOnlyRecap(gameId) {
  const game = db.prepare(`
    SELECT g.*, sp.name AS sport_name FROM games g
    JOIN teams t ON t.id = g.team_id JOIN sports sp ON sp.id = t.sport_id
    WHERE g.id = ?
  `).get(gameId);
  if (!game) throw new Error('Game not found');
  const contact = db.prepare(`SELECT * FROM contacts WHERE team_id = ? AND is_primary = 1 AND is_active = 1 LIMIT 1`).get(game.team_id);
  if (!contact || !contact.phone) return { skipped: 'No contact phone' };

  const body = fillTemplate(settings.get('text_only_recap_template'), {
    coach_name: contact.name.split(' ')[0],
    outlet_name: settings.get('outlet_name'),
    opponent: game.opponent || 'opponent',
  });
  const r = await sendSMS(contact.phone, body);
  if (!r.skipped) {
    db.prepare(`UPDATE games SET call_requested = 1 WHERE id = ?`).run(gameId);
    logEvent('sms_sent', `Text-only recap request to ${contact.name} for game ${gameId}`, gameId);
  }
  return r;
}

async function sendIntroText(contactId) {
  const c = db.prepare(`
    SELECT c.*, sp.name AS sport_name, s.name AS school_name
    FROM contacts c
    JOIN teams t ON t.id = c.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE c.id = ?
  `).get(contactId);
  if (!c) throw new Error(`Contact ${contactId} not found`);
  if (!c.phone) return { skipped: `${c.name} has no phone.` };

  const body = fillTemplate(settings.get('intro_text_template'), {
    coach_name: c.name.split(' ')[0],
    outlet_name: settings.get('outlet_name'),
    school: c.school_name,
    sport: c.sport_name,
  });
  const r = await sendSMS(c.phone, body);
  if (r.skipped) return { skipped: r.skipped, contact: c };
  db.prepare(`UPDATE contacts SET onboarded_at = datetime('now') WHERE id = ?`).run(contactId);
  logEvent('sms_sent', `Intro text sent to ${c.name} (${c.phone})`, null);
  return { ...r, contact: c };
}

// Validate Twilio webhook signature.
function validateRequest(req, fullUrl) {
  const token = settings.get('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const signature = req.header('X-Twilio-Signature');
  if (!signature) return false;
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  return twilio.validateRequest(token, signature, fullUrl, req.body || {});
}

// Download an MMS media URL to ./uploads/<game_id>/<timestamp>.<ext>
async function downloadMedia(mediaUrl, gameId) {
  const sid = settings.get('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID;
  const token = settings.get('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const r = await fetch(mediaUrl, { headers: { Authorization: auth }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Twilio media fetch ${r.status}`);
  const contentType = r.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.split('/')[1].split(';')[0] || 'jpg';
  const dir = path.join(process.env.UPLOAD_DIR || './uploads', String(gameId));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}.${ext}`;
  const filePath = path.join(dir, filename);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return { filePath, mimeType: contentType };
}

module.exports = {
  getClient, getFromNumber, fillTemplate,
  sendSMS, sendPhotoRequest, sendTextOnlyRecap, sendIntroText,
  validateRequest, downloadMedia,
};
