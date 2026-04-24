const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const users = db.prepare(`
    SELECT id, username, role, is_active, created_at FROM users ORDER BY created_at DESC
  `).all();
  res.render('pages/users', {
    title: 'Users',
    users,
    flash: req.session.flash || null,
  });
  delete req.session.flash;
});

router.post('/', (req, res) => {
  const { username, password, role } = req.body;
  const u = (username || '').trim();
  if (!u) { req.session.flash = { type: 'error', message: 'Username required.' }; return res.redirect('/users'); }
  if (!password || password.length < 8) { req.session.flash = { type: 'error', message: 'Password must be at least 8 characters.' }; return res.redirect('/users'); }
  if (!['admin', 'operator'].includes(role)) { req.session.flash = { type: 'error', message: 'Invalid role.' }; return res.redirect('/users'); }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
  if (existing) { req.session.flash = { type: 'error', message: `User "${u}" already exists.` }; return res.redirect('/users'); }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(u, hash, role);
  req.session.flash = { type: 'success', message: `Added user "${u}".` };
  res.redirect('/users');
});

router.post('/:id/reset', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { password } = req.body;
  if (!password || password.length < 8) { req.session.flash = { type: 'error', message: 'Password must be at least 8 characters.' }; return res.redirect('/users'); }
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  if (!user) { req.session.flash = { type: 'error', message: 'User not found.' }; return res.redirect('/users'); }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
  req.session.flash = { type: 'success', message: `Reset password for "${user.username}".` };
  res.redirect('/users');
});

router.post('/:id/toggle', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.session.userId) {
    req.session.flash = { type: 'error', message: "You can't deactivate your own account." };
    return res.redirect('/users');
  }
  const user = db.prepare('SELECT username, is_active FROM users WHERE id = ?').get(id);
  if (!user) { req.session.flash = { type: 'error', message: 'User not found.' }; return res.redirect('/users'); }

  // Don't allow deactivating the last active admin
  if (user.is_active) {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1`).get().c;
    const isAdmin = db.prepare(`SELECT 1 FROM users WHERE id = ? AND role = 'admin'`).get(id);
    if (isAdmin && adminCount <= 1) {
      req.session.flash = { type: 'error', message: 'Cannot deactivate the last active admin.' };
      return res.redirect('/users');
    }
  }

  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(user.is_active ? 0 : 1, id);
  req.session.flash = { type: 'success', message: `${user.is_active ? 'Deactivated' : 'Reactivated'} "${user.username}".` };
  res.redirect('/users');
});

router.post('/:id/role', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!['admin', 'operator'].includes(role)) { req.session.flash = { type: 'error', message: 'Invalid role.' }; return res.redirect('/users'); }
  const user = db.prepare('SELECT username, role FROM users WHERE id = ?').get(id);
  if (!user) { req.session.flash = { type: 'error', message: 'User not found.' }; return res.redirect('/users'); }

  if (user.role === 'admin' && role === 'operator') {
    const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1`).get().c;
    if (adminCount <= 1) { req.session.flash = { type: 'error', message: 'Cannot demote the last active admin.' }; return res.redirect('/users'); }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  req.session.flash = { type: 'success', message: `Set "${user.username}" role to ${role}.` };
  res.redirect('/users');
});

module.exports = router;
