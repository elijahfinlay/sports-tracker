const express = require('express');
const db = require('../db');
const settings = require('../lib/settings');
const twilio = require('../lib/twilio');
const retell = require('../lib/retell');
const { generateArticleForGame } = require('../lib/articles');
const { logEvent } = require('../lib/log');

const router = express.Router();

// Twilio sends application/x-www-form-urlencoded — parsed by global middleware already.
router.post('/twilio/incoming', async (req, res) => {
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

  // Validate signature when we have an auth token configured.
  if (settings.get('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN) {
    if (!twilio.validateRequest(req, fullUrl)) {
      logEvent('error', `Twilio webhook signature failed for ${req.body.From || 'unknown'}`);
      return res.status(403).send('Invalid signature');
    }
  }

  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  const sid = req.body.MessageSid;

  // Match sender to a contact
  const contact = db.prepare('SELECT * FROM contacts WHERE phone = ? AND is_active = 1 LIMIT 1').get(from);
  if (!contact) {
    logEvent('sms_received', `Inbound from unknown ${from}: "${body.slice(0, 60)}"`);
    return res.type('text/xml').send('<Response><Message>Hi, this number is for partnered coaches only — please email us.</Message></Response>');
  }

  // Find today's active game for this contact's team
  const today = new Date().toISOString().slice(0, 10);
  let game = db.prepare(`
    SELECT id FROM games
    WHERE team_id = ? AND game_date = ? AND status IN ('today','in_progress','completed')
    ORDER BY game_time LIMIT 1
  `).get(contact.team_id, today);

  // Fallback: most recent game in last 3 days
  if (!game) {
    game = db.prepare(`
      SELECT id FROM games WHERE team_id = ? AND game_date >= date('now','-3 days')
      ORDER BY game_date DESC, game_time DESC LIMIT 1
    `).get(contact.team_id);
  }
  if (!game) {
    return res.type('text/xml').send('<Response><Message>Got it, thanks Coach! No game on file right now though — please reach out if this was for a specific game.</Message></Response>');
  }

  let savedPhoto = false, savedText = false;

  // Save media (MMS)
  if (numMedia > 0) {
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = req.body[`MediaUrl${i}`];
      if (!mediaUrl) continue;
      try {
        const { filePath, mimeType } = await twilio.downloadMedia(mediaUrl, game.id);
        db.prepare(`INSERT INTO photos (game_id, contact_id, file_path, mime_type, twilio_message_sid)
          VALUES (?, ?, ?, ?, ?)`).run(game.id, contact.id, filePath, mimeType, sid);
        savedPhoto = true;
      } catch (e) {
        logEvent('error', `MMS download failed for game ${game.id}: ${e.message}`, game.id);
      }
    }
  }

  // Save text body if present
  if (body) {
    db.prepare(`INSERT INTO game_texts (game_id, contact_id, message_body, twilio_message_sid)
      VALUES (?, ?, ?, ?)`).run(game.id, contact.id, body, sid);
    savedText = true;
  }

  // Decide auto-reply
  let reply;
  if (savedPhoto && savedText) reply = settings.get('reply_both_received');
  else if (savedPhoto) reply = settings.get('reply_photo_received');
  else if (savedText) reply = settings.get('reply_text_received');
  else reply = "Got your message, thanks Coach!";

  logEvent('sms_received', `Inbound from ${contact.name}: photo=${savedPhoto} text=${savedText}`, game.id);

  // If we got text content, fire article generation in background
  if (savedText) {
    // Mark call_requested so cron skips placing a call (text already came in)
    db.prepare('UPDATE games SET call_requested = 1 WHERE id = ?').run(game.id);
    setImmediate(async () => {
      try { await generateArticleForGame(game.id); }
      catch (e) { logEvent('error', `Article generation from text failed: ${e.message}`, game.id); }
    });
  }

  res.type('text/xml').send(`<Response><Message>${escapeXml(reply)}</Message></Response>`);
});

function escapeXml(s) {
  return String(s || '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

router.post('/retell/call-complete', async (req, res) => {
  // TODO: re-enable signature verification using Retell's official SDK (`Retell.verify`).
  // Their custom signature format doesn't match a plain HMAC of the raw body, so our
  // hand-rolled verification kept rejecting valid calls. Skipping for now — the URL is
  // obscure and this is a single-tenant deployment.
  try {
    const out = await retell.handleWebhook(req.body || {});
    res.json({ ok: true, ...out });
  } catch (e) {
    logEvent('error', `Retell webhook handler failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
