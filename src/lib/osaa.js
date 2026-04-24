const cheerio = require('cheerio');
const db = require('../db');
const { logEvent } = require('./log');

const BASE = process.env.OSAA_API_BASE_URL || 'https://www.osaa.org/api';
const SITE = 'https://www.osaa.org';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/html,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function fetchJSON(url) {
  const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (r.status === 403) {
    const txt = await r.text();
    if (txt.includes('Just a moment')) {
      const err = new Error(`OSAA: blocked by Cloudflare challenge (${url})`);
      err.cloudflare = true;
      throw err;
    }
  }
  if (!r.ok) throw new Error(`OSAA: HTTP ${r.status} for ${url}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (r.status === 403) {
    const txt = await r.text();
    if (txt.includes('Just a moment')) {
      const err = new Error(`OSAA: blocked by Cloudflare challenge (${url})`);
      err.cloudflare = true;
      throw err;
    }
  }
  if (!r.ok) throw new Error(`OSAA: HTTP ${r.status} for ${url}`);
  return r.text();
}

// Pull teams for a school (current school year). Returns OSAA's array.
async function fetchSchoolTeams(osaaSchoolId) {
  return fetchJSON(`${BASE}/schools/${osaaSchoolId}/teams`);
}

// Pull schedule for a team. Returns OSAA's contest array.
async function fetchTeamSchedule(osaaTeamId) {
  return fetchJSON(`${BASE}/teams/${osaaTeamId}/schedule`);
}

// CSV fallback (from /demo/teams/:id/schedule)
async function fetchTeamScheduleCSV(osaaTeamId) {
  const text = await fetchText(`${SITE}/demo/teams/${osaaTeamId}/schedule`);
  return parseScheduleCSV(text);
}

function parseScheduleCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cols = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => row[h] = cols[i]);
    return row;
  });
}

function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Scrape coach names from a team page (HTML). Returns [{ name, role }].
async function scrapeTeamCoaches(osaaTeamId) {
  const html = await fetchText(`${SITE}/teams/${osaaTeamId}`);
  const $ = cheerio.load(html);
  const coaches = [];
  // OSAA team pages usually have a "Coaches" section. We scan for any element
  // containing "Coach" labels and pair with an adjacent name.
  $('*:contains("Head Coach"), *:contains("Assistant Coach")').each((_, el) => {
    const text = $(el).text().trim();
    const m = text.match(/(Head Coach|Assistant Coach)[\s:]+([A-Z][a-zA-Z'.\- ]+)/);
    if (m && !coaches.find(c => c.name === m[2].trim())) {
      coaches.push({ role: m[1], name: m[2].trim() });
    }
  });
  return coaches;
}

// Map OSAA contest status → our games.status
function mapContestStatus(osaaStatus) {
  switch ((osaaStatus || '').toUpperCase()) {
    case 'SCHD': case 'PPD': return 'upcoming';
    case 'LIVE': return 'in_progress';
    case 'DONE': return 'completed';
    case 'DEL':  return 'cancelled';
    default: return 'upcoming';
  }
}

// Find or create a team row; return its id.
function upsertTeam({ schoolId, sportId, osaaTeamId, level = 'V' }) {
  const existing = db.prepare(
    'SELECT id FROM teams WHERE school_id = ? AND sport_id = ? AND level = ?'
  ).get(schoolId, sportId, level);
  if (existing) {
    if (osaaTeamId) {
      db.prepare('UPDATE teams SET osaa_team_id = ? WHERE id = ?').run(osaaTeamId, existing.id);
    }
    return existing.id;
  }
  const info = db.prepare(
    'INSERT INTO teams (school_id, sport_id, osaa_team_id, level) VALUES (?, ?, ?, ?)'
  ).run(schoolId, sportId, osaaTeamId, level);
  return info.lastInsertRowid;
}

// Sync teams for one school.
async function syncSchoolTeams(schoolId) {
  const school = db.prepare('SELECT * FROM schools WHERE id = ?').get(schoolId);
  if (!school) throw new Error(`School ${schoolId} not found`);
  if (!school.osaa_id) {
    logEvent('error', `School ${school.name} has no OSAA id`);
    return { added: 0, updated: 0 };
  }

  let teams;
  try {
    teams = await fetchSchoolTeams(school.osaa_id);
  } catch (e) {
    logEvent('error', `OSAA team fetch failed for ${school.name}: ${e.message}`);
    return { added: 0, updated: 0, error: e.message };
  }

  let added = 0, updated = 0;
  const sportsBySlug = new Map(db.prepare('SELECT id, osaa_slug FROM sports').all().map(s => [s.osaa_slug, s.id]));

  for (const t of teams) {
    const slug = (t.activity || t.sport || '').toLowerCase();
    const sportId = sportsBySlug.get(slug);
    if (!sportId) continue;
    const level = (t.level || 'V').toUpperCase();
    const existing = db.prepare(
      'SELECT id FROM teams WHERE school_id = ? AND sport_id = ? AND level = ?'
    ).get(schoolId, sportId, level);
    if (existing) {
      db.prepare('UPDATE teams SET osaa_team_id = ? WHERE id = ?').run(t.id || t.team_id, existing.id);
      updated++;
    } else {
      db.prepare('INSERT INTO teams (school_id, sport_id, osaa_team_id, level) VALUES (?, ?, ?, ?)')
        .run(schoolId, sportId, t.id || t.team_id, level);
      added++;
    }
  }
  logEvent('osaa_sync', `Synced teams for ${school.name}: +${added}, updated ${updated}`);
  return { added, updated };
}

// Sync schedule for one team. Upserts games. Returns { added, updated, errors }.
async function syncTeamSchedule(teamId) {
  const team = db.prepare(`
    SELECT t.*, s.name AS school_name FROM teams t
    JOIN schools s ON s.id = t.school_id WHERE t.id = ?
  `).get(teamId);
  if (!team) throw new Error(`Team ${teamId} not found`);
  if (!team.osaa_team_id) return { added: 0, updated: 0, error: 'no osaa_team_id' };

  let contests;
  try {
    contests = await fetchTeamSchedule(team.osaa_team_id);
  } catch (e) {
    if (e.cloudflare) {
      try {
        contests = await fetchTeamScheduleCSV(team.osaa_team_id);
      } catch (e2) {
        logEvent('error', `Schedule sync failed for team ${teamId}: ${e2.message}`);
        return { added: 0, updated: 0, error: e2.message };
      }
    } else {
      logEvent('error', `Schedule sync failed for team ${teamId}: ${e.message}`);
      return { added: 0, updated: 0, error: e.message };
    }
  }

  let added = 0, updated = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const c of contests) {
    const contestId = c.id || c.contest_id || c.contestId;
    const date = (c.date || c.game_date || '').slice(0, 10);
    const time = c.time || c.game_time || null;
    const opponent = c.opponent || c.away_team || c.home_team || c.opponent_name;
    const location = c.location || c.venue || null;
    const status = mapContestStatus(c.status);
    const result = c.result || null;
    const finalStatus = (status === 'upcoming' && date === today) ? 'today' : status;

    const existing = contestId ? db.prepare('SELECT id, status FROM games WHERE osaa_contest_id = ?').get(contestId) : null;
    if (existing) {
      db.prepare(`
        UPDATE games SET opponent = ?, location = ?, game_date = ?, game_time = ?,
          status = ?, result = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(opponent, location, date, time, finalStatus, result, existing.id);
      updated++;
    } else if (date) {
      db.prepare(`
        INSERT INTO games (team_id, osaa_contest_id, opponent, location, game_date, game_time, status, result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(teamId, contestId, opponent, location, date, time, finalStatus, result);
      added++;
    }
  }

  return { added, updated };
}

// Sync coach names for one team — pre-populates contacts with name + role, no phone.
async function syncTeamCoaches(teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team || !team.osaa_team_id) return { added: 0 };
  let coaches;
  try { coaches = await scrapeTeamCoaches(team.osaa_team_id); }
  catch (e) {
    logEvent('error', `Coach scrape failed for team ${teamId}: ${e.message}`);
    return { added: 0, error: e.message };
  }
  let added = 0;
  for (const c of coaches) {
    const existing = db.prepare('SELECT id FROM contacts WHERE team_id = ? AND name = ?').get(teamId, c.name);
    if (existing) continue;
    db.prepare(`INSERT INTO contacts (team_id, name, role, is_primary) VALUES (?, ?, ?, ?)`)
      .run(teamId, c.name, c.role, c.role === 'Head Coach' ? 1 : 0);
    added++;
  }
  return { added };
}

// Full nightly sync — all schools, all teams, all schedules.
async function syncAll() {
  logEvent('osaa_sync', 'Full sync started');
  const schools = db.prepare('SELECT id FROM schools WHERE is_active = 1').all();
  for (const { id } of schools) {
    await syncSchoolTeams(id);
  }
  const teams = db.prepare('SELECT id FROM teams WHERE is_active = 1 AND osaa_team_id IS NOT NULL').all();
  for (const { id } of teams) {
    await syncTeamSchedule(id);
  }
  // Mark yesterday's "today" games as completed (fallback — call flow also does this).
  db.prepare(`UPDATE games SET status = 'completed' WHERE status = 'today' AND game_date < date('now')`).run();
  logEvent('osaa_sync', 'Full sync complete');
}

module.exports = {
  fetchSchoolTeams, fetchTeamSchedule, fetchTeamScheduleCSV,
  scrapeTeamCoaches, syncSchoolTeams, syncTeamSchedule, syncTeamCoaches, syncAll,
  mapContestStatus, upsertTeam,
};
