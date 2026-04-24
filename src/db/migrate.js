require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./index');

db.exec(`
  CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const dir = path.join(__dirname, 'migrations');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

const applied = new Set(db.prepare('SELECT name FROM migrations').all().map(r => r.name));

let ran = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
  });
  tx();
  console.log(`Applied: ${file}`);
  ran++;
}

if (ran === 0) console.log('No new migrations.');
process.exit(0);
