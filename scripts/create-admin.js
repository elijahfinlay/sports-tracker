require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (silent) {
    // Mute the prompt for password
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, enc, cb) => {
      if (chunk.toString().includes(question)) origWrite(chunk, enc, cb);
      else origWrite('', enc, cb);
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (silent) process.stdout.write = process.stdout.write.bind(process.stdout);
      resolve(answer.trim());
    });
  });
}

(async () => {
  const username = process.argv[2] || await ask('Username: ');
  if (!username) { console.error('Username required.'); process.exit(1); }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) { console.error(`User "${username}" already exists.`); process.exit(1); }

  const password = process.argv[3] || await ask('Password: ');
  if (!password || password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, 'admin');
  console.log(`Created admin user "${username}" (id ${info.lastInsertRowid}).`);
  process.exit(0);
})();
