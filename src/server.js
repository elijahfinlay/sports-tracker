require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const db = require('./db');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const settingsRoutes = require('./routes/settings');
const usersRoutes = require('./routes/users');
const teamsRoutes = require('./routes/teams');
const contactsRoutes = require('./routes/contacts');
const gamesRoutes = require('./routes/games');
const articlesRoutes = require('./routes/articles');
const activityRoutes = require('./routes/activity');
const webhooksRoutes = require('./routes/webhooks');
const apiRoutes = require('./routes/api');
const { requireAuth } = require('./middleware/auth');
const { startCron } = require('./lib/cron');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Trust the first proxy (Railway/Fly/etc terminate TLS in front of us).
// Without this, secure cookies are rejected because Express thinks the request is HTTP.
app.set('trust proxy', 1);

// Capture raw body for the Retell webhook so HMAC verification matches the bytes Retell signed.
// Must be registered BEFORE express.json() — once json() consumes the stream, the raw bytes are gone.
app.use('/webhooks/retell', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Keep the session DB next to the main DB so a single mounted volume covers both.
const sessionDir = path.dirname(process.env.DATABASE_PATH || './data/sports.db');

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: sessionDir }),
  secret: process.env.SESSION_SECRET || 'dev-only-not-secure',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 14,
  },
}));

// Inject current user into all views
app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    req.user = {
      id: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    };
  }
  res.locals.user = req.user || null;
  res.locals.currentPath = req.path;
  next();
});

// Public webhooks (no auth) — must come before requireAuth
app.use('/webhooks', webhooksRoutes);

// Public REST API (bearer-token auth happens inside the router)
app.use('/api', apiRoutes);

// Public
app.use('/', authRoutes);

// Authenticated
app.use('/', requireAuth, dashboardRoutes);
app.use('/settings', requireAuth, settingsRoutes);
app.use('/users', requireAuth, usersRoutes);
app.use('/', requireAuth, teamsRoutes);
app.use('/', requireAuth, contactsRoutes);
app.use('/', requireAuth, gamesRoutes);
app.use('/', requireAuth, articlesRoutes);
app.use('/', requireAuth, activityRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('pages/error', {
    title: 'Not found',
    message: `No route for ${req.method} ${req.path}`,
    user: req.user || null,
  });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('pages/error', {
    title: 'Error',
    message: process.env.NODE_ENV === 'production' ? 'Something went wrong.' : err.message,
    user: req.user || null,
  });
});

app.listen(PORT, () => {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  console.log(`\nRoseburg Sports running on http://localhost:${PORT}`);
  if (userCount === 0) {
    console.log(`No users yet. Run: npm run create-admin <username> <password>\n`);
  }
  if (process.env.DISABLE_CRON !== '1') startCron();
});
