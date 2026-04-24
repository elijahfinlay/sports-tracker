const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('pages/login', { title: 'Sign in', error: null, username: '' });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).render('pages/login', {
      title: 'Sign in', error: 'Username and password required.', username: username || '',
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('pages/login', {
      title: 'Sign in', error: 'Invalid username or password.', username,
    });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).render('pages/login', { title: 'Sign in', error: 'Session error.', username });
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;
