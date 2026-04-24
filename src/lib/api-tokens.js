const crypto = require('crypto');
const db = require('../db');

function generate() {
  // 32 bytes = 256 bits, base64url
  return crypto.randomBytes(32).toString('base64url');
}

function hash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function create(name) {
  const token = generate();
  const tokenHash = hash(token);
  const info = db.prepare('INSERT INTO api_tokens (name, token_hash) VALUES (?, ?)').run(name, tokenHash);
  return { id: info.lastInsertRowid, token };
}

function verify(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND is_active = 1').get(hash(token));
  if (!row) return null;
  db.prepare(`UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  return row;
}

function list() {
  return db.prepare('SELECT id, name, last_used_at, is_active, created_at FROM api_tokens ORDER BY created_at DESC').all();
}

function revoke(id) {
  db.prepare('UPDATE api_tokens SET is_active = 0 WHERE id = ?').run(id);
}

module.exports = { create, verify, list, revoke };
