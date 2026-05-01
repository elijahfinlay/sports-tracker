const db = require('../db');
const settings = require('./settings');
const { logEvent } = require('./log');
const { generateArticleForGame } = require('./articles');

const BASE = 'https://api.retellai.com';

function getKey() {
  return settings.get('retell_api_key') || process.env.RETELL_API_KEY;
}
function getAgent() {
  return settings.get('retell_agent_id') || process.env.RETELL_AGENT_ID;
}
function getFromNumber() {
  // Re-use the Twilio number for caller ID, since plan didn't separate.
  return settings.get('twilio_phone_number') || process.env.TWILIO_PHONE_NUMBER;
}

async function triggerCall(gameId, opts = {}) {
  const key = getKey();
  const agent = getAgent();
  const from = getFromNumber();
  if (!key || !agent) return { skipped: 'Retell not configured (set credentials in Settings).' };

  const game = db.prepare(`
    SELECT g.*, sp.name AS sport_name, s.name AS school_name
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE g.id = ?
  `).get(gameId);
  if (!game) throw new Error(`Game ${gameId} not found`);

  let contact;
  if (opts.contactId) {
    contact = db.prepare(`SELECT * FROM contacts WHERE id = ? AND team_id = ? AND is_active = 1`).get(opts.contactId, game.team_id);
    if (!contact) return { skipped: 'Selected contact is inactive or not on this team.' };
  } else {
    contact = db.prepare(`SELECT * FROM contacts WHERE team_id = ? AND is_primary = 1 AND is_active = 1 LIMIT 1`).get(game.team_id);
    if (!contact) return { skipped: 'No primary contact for team.' };
  }
  if (!contact.phone) return { skipped: `${contact.name} has no phone.` };

  const r = await fetch(`${BASE}/v2/create-phone-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      from_number: from,
      to_number: contact.phone,
      override_agent_id: agent,
      retell_llm_dynamic_variables: (() => {
        const parts = (contact.name || '').trim().split(/\s+/);
        const first = parts[0] || '';
        const last = parts.length > 1 ? parts[parts.length - 1] : first;
        return {
          coach_name: contact.name,         // full name, e.g. "John Smith"
          coach_first_name: first,          // "John"
          coach_last_name: last,            // "Smith" — best for "Hey Coach {{coach_last_name}}"
          outlet_name: settings.get('outlet_name'),
          school: game.school_name,
          sport: game.sport_name,
          opponent: game.opponent || 'their opponent',
          game_date: game.game_date,
        };
      })(),
      metadata: { game_id: String(gameId), is_retry: !!opts.isRetry, manual: !!opts.manual },
    }),
  });

  const data = await r.json();
  if (!r.ok) {
    db.prepare('INSERT INTO calls (game_id, contact_id, status) VALUES (?, ?, ?)').run(gameId, contact.id, 'failed');
    db.prepare('UPDATE games SET call_requested = 1 WHERE id = ?').run(gameId);
    logEvent('error', `Retell call failed for game ${gameId}: ${JSON.stringify(data).slice(0, 200)}`, gameId);
    return { error: data.error || 'Retell error' };
  }

  db.prepare(`INSERT INTO calls (game_id, contact_id, retell_call_id, status, started_at)
    VALUES (?, ?, ?, ?, datetime('now'))`).run(gameId, contact.id, data.call_id, 'initiated');
  db.prepare('UPDATE games SET call_requested = 1 WHERE id = ?').run(gameId);
  logEvent('call_initiated', `Retell call to ${contact.name} for game ${gameId} (id=${data.call_id})`, gameId);
  return { call_id: data.call_id };
}

// Handle Retell webhook payload (call_analyzed, call_ended, etc.)
async function handleWebhook(payload) {
  const event = payload.event || payload.type;
  const call = payload.call || payload.data || payload;
  const callId = call.call_id || call.id;
  if (!callId) return { ignored: 'no call_id' };

  const ourCall = db.prepare('SELECT * FROM calls WHERE retell_call_id = ?').get(callId);
  if (!ourCall) return { ignored: `unknown call_id ${callId}` };

  if (event === 'call_started' || event === 'call_inbound') {
    db.prepare(`UPDATE calls SET status = 'in_progress' WHERE id = ?`).run(ourCall.id);
    return { ok: true };
  }

  if (event === 'call_ended' || event === 'call_analyzed') {
    const transcript = call.transcript || (call.call_analysis && call.call_analysis.transcript) || null;
    const duration = call.duration_ms ? Math.round(call.duration_ms / 1000) : (call.duration_seconds || null);
    const status = (call.disconnect_reason === 'voicemail' || call.disconnect_reason === 'no_answer') ? 'no_answer'
      : (call.call_status === 'ended' || event === 'call_analyzed') ? 'completed' : 'failed';

    db.prepare(`UPDATE calls SET status = ?, transcript = ?, duration_seconds = ?, ended_at = datetime('now') WHERE id = ?`)
      .run(status, transcript, duration, ourCall.id);

    if (status === 'completed' && transcript) {
      db.prepare('UPDATE games SET call_completed = 1, status = ? WHERE id = ?').run('completed', ourCall.game_id);
      logEvent('call_completed', `Call ${callId} for game ${ourCall.game_id} completed (${duration}s)`, ourCall.game_id);
      try { await generateArticleForGame(ourCall.game_id); }
      catch (e) { logEvent('error', `Article gen failed for game ${ourCall.game_id}: ${e.message}`, ourCall.game_id); }
    } else {
      logEvent('error', `Call ${callId} ended without usable transcript (status=${status})`, ourCall.game_id);
    }
    return { ok: true };
  }

  return { ignored: `unhandled event ${event}` };
}

module.exports = { triggerCall, handleWebhook };
