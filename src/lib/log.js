const db = require('../db');

function logEvent(type, message, gameId = null) {
  try {
    db.prepare('INSERT INTO notification_log (type, related_game_id, message) VALUES (?, ?, ?)').run(type, gameId, message);
  } catch (e) {
    console.error('Failed to log event', e);
  }
  console.log(`[${type}]${gameId ? ` game=${gameId}` : ''} ${message}`);
}

module.exports = { logEvent };
