const cron = require('node-cron');
const db = require('../db');
const osaa = require('./osaa');
const settings = require('./settings');
const { sendPhotoRequest, sendTextOnlyRecap } = require('./twilio');
const { triggerCall } = require('./retell');
const { logEvent } = require('./log');

// Returns the JS Date for "today's send time" given a game record.
function photoRequestSendTime(game) {
  if (!game.game_time) return null;
  const offsetMin = parseFloat(settings.get('photo_text_offset_minutes') || '-30');
  const [h, m] = game.game_time.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m + offsetMin, 0, 0);
  return d;
}

function callTriggerTime(game, sportSlug) {
  if (!game.game_time) return null;
  const durations = settings.getJSON('sport_game_durations') || {};
  const dur = durations[sportSlug] || 150;
  const callOffset = parseFloat(settings.get('call_offset_minutes') || '45');
  const [h, m] = game.game_time.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m + dur + callOffset, 0, 0);
  return d;
}

// Mark today's games and run any due photo requests.
async function tickGameDay() {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();

  // 1. Promote any "upcoming" games whose date is today.
  db.prepare(`UPDATE games SET status = 'today' WHERE status = 'upcoming' AND game_date = ?`).run(today);

  // 2. Photo requests for today's games whose send time has passed.
  const photoTargets = db.prepare(`
    SELECT g.id, g.game_time FROM games g
    WHERE g.game_date = ? AND g.status IN ('today','in_progress') AND g.photo_requested = 0
  `).all(today);

  for (const g of photoTargets) {
    const sendAt = photoRequestSendTime(g);
    if (sendAt && sendAt <= now) {
      try { await sendPhotoRequest(g.id); }
      catch (e) { logEvent('error', `Photo request failed for game ${g.id}: ${e.message}`, g.id); }
    }
  }

  // 3. Post-game contact (call OR text-only recap) for games whose call time has passed.
  const callTargets = db.prepare(`
    SELECT g.id, g.game_time, sp.osaa_slug AS sport_slug
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    WHERE g.game_date = ? AND g.status IN ('today','in_progress','completed') AND g.call_requested = 0
  `).all(today);

  for (const g of callTargets) {
    const callAt = callTriggerTime(g, g.sport_slug);
    if (callAt && callAt <= now) {
      // Check if a game_text already came in — if so, skip
      const hasText = db.prepare('SELECT 1 FROM game_texts WHERE game_id = ?').get(g.id);
      if (hasText) {
        db.prepare('UPDATE games SET call_requested = 1 WHERE id = ?').run(g.id);
        logEvent('call_skipped', `Call skipped for game ${g.id} — text already received`, g.id);
        continue;
      }
      // Look up primary contact's preference
      const contact = db.prepare(`
        SELECT c.* FROM contacts c WHERE c.team_id = (SELECT team_id FROM games WHERE id = ?)
        AND c.is_primary = 1 AND c.is_active = 1 LIMIT 1
      `).get(g.id);
      if (!contact) {
        logEvent('error', `No contact for game ${g.id}`, g.id);
        db.prepare('UPDATE games SET call_requested = 1 WHERE id = ?').run(g.id);
        continue;
      }
      try {
        if (contact.preference === 'text_only') await sendTextOnlyRecap(g.id);
        else await triggerCall(g.id);
      } catch (e) {
        logEvent('error', `Post-game contact failed for game ${g.id}: ${e.message}`, g.id);
      }
    }
  }

  // 4. Retry failed calls (one retry, 30 min after fail).
  const retryTargets = db.prepare(`
    SELECT g.id FROM games g
    WHERE g.call_requested = 1 AND g.call_completed = 0 AND g.call_retry_count = 0
      AND EXISTS (
        SELECT 1 FROM calls c WHERE c.game_id = g.id
        AND c.status IN ('failed','no_answer')
        AND c.created_at <= datetime('now','-30 minutes')
      )
  `).all();
  for (const g of retryTargets) {
    try {
      await triggerCall(g.id, { isRetry: true });
      db.prepare('UPDATE games SET call_retry_count = 1 WHERE id = ?').run(g.id);
    } catch (e) { logEvent('error', `Retry call failed for game ${g.id}: ${e.message}`, g.id); }
  }

  // 5. Text-only nudge after 2 hours with no reply.
  const nudgeTargets = db.prepare(`
    SELECT g.id FROM games g
    JOIN contacts c ON c.team_id = g.team_id AND c.is_primary = 1 AND c.is_active = 1
    WHERE c.preference = 'text_only'
      AND g.call_requested = 1
      AND g.game_date = ?
      AND NOT EXISTS (SELECT 1 FROM game_texts gt WHERE gt.game_id = g.id)
      AND NOT EXISTS (
        SELECT 1 FROM notification_log nl WHERE nl.related_game_id = g.id AND nl.type = 'sms_nudged'
      )
  `).all(today);
  const { sendSMS, fillTemplate } = require('./twilio');
  for (const g of nudgeTargets) {
    const contact = db.prepare(`SELECT * FROM contacts WHERE team_id = (SELECT team_id FROM games WHERE id = ?) AND is_primary = 1 AND is_active = 1 LIMIT 1`).get(g.id);
    if (!contact || !contact.phone) continue;
    const body = fillTemplate(settings.get('text_only_nudge_template'), { coach_name: contact.name.split(' ')[0] });
    try {
      const r = await sendSMS(contact.phone, body);
      if (!r.skipped) logEvent('sms_nudged', `Nudge sent to ${contact.name} for game ${g.id}`, g.id);
    } catch (e) { logEvent('error', `Nudge failed for game ${g.id}: ${e.message}`, g.id); }
  }
}

function startCron() {
  // OSAA full sync: 6am and 6pm
  cron.schedule('0 6,18 * * *', async () => {
    try { await osaa.syncAll(); }
    catch (e) { logEvent('error', `OSAA syncAll failed: ${e.message}`); }
  });

  // Game-day tick: every minute
  cron.schedule('* * * * *', async () => {
    try { await tickGameDay(); }
    catch (e) { logEvent('error', `tickGameDay failed: ${e.message}`); }
  });

  console.log('Cron jobs scheduled (OSAA sync 6/18; game-day tick every minute).');
}

module.exports = { startCron, tickGameDay };
