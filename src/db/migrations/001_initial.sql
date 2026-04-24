-- Users (dashboard operators)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin','operator')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Schools
CREATE TABLE schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osaa_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  classification TEXT,
  mascot TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Sports (OSAA-sanctioned activities)
CREATE TABLE sports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  osaa_slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  season TEXT CHECK (season IN ('fall','winter','spring'))
);

-- Teams (school + sport + level)
CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  sport_id INTEGER NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  osaa_team_id INTEGER,
  level TEXT NOT NULL DEFAULT 'V' CHECK (level IN ('V','JV','JV2','FR','FR2')),
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (school_id, sport_id, level)
);

-- Contacts (coaches and staff)
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT,
  phone TEXT,
  email TEXT,
  is_primary INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  preference TEXT NOT NULL DEFAULT 'call' CHECK (preference IN ('call','text_only')),
  onboarded_at TEXT
);
CREATE INDEX idx_contacts_phone ON contacts(phone);
CREATE INDEX idx_contacts_team ON contacts(team_id);

-- Games
CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  osaa_contest_id INTEGER UNIQUE,
  opponent TEXT,
  location TEXT,
  game_date TEXT NOT NULL,
  game_time TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','today','in_progress','completed','cancelled')),
  result TEXT,
  photo_requested INTEGER NOT NULL DEFAULT 0,
  photo_request_sent_at TEXT,
  call_requested INTEGER NOT NULL DEFAULT 0,
  call_completed INTEGER NOT NULL DEFAULT 0,
  call_retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_games_date ON games(game_date);
CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_games_team ON games(team_id);

-- Photos (received via MMS)
CREATE TABLE photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  original_filename TEXT,
  mime_type TEXT,
  twilio_message_sid TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_photos_game ON photos(game_id);

-- Calls (Retell voice interviews)
CREATE TABLE calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  retell_call_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','in_progress','completed','failed','no_answer')),
  duration_seconds INTEGER,
  transcript TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_calls_game ON calls(game_id);

-- Game texts (game info coaches text in)
CREATE TABLE game_texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  message_body TEXT NOT NULL,
  twilio_message_sid TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_game_texts_game ON game_texts(game_id);

-- Articles (Claude-generated drafts)
CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  call_id INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  game_text_id INTEGER REFERENCES game_texts(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('call','text')),
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','published','rejected')),
  thin_source INTEGER NOT NULL DEFAULT 0,
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  published_at TEXT,
  photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_articles_status ON articles(status);
CREATE INDEX idx_articles_game ON articles(game_id);

-- Settings (key/value)
CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  value TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Notification log (system events)
CREATE TABLE notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  related_game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notif_log_created ON notification_log(created_at);
CREATE INDEX idx_notif_log_type ON notification_log(type);

-- API tokens (for external consumers like the news site)
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
