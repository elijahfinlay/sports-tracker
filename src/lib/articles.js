const db = require('../db');
const settings = require('./settings');
const { logEvent } = require('./log');

const DEFAULT_PROMPT = `You are a local sports reporter writing post-game recaps for a community newspaper.

Style:
- Tight, factual, warm. Active voice. Short paragraphs.
- Lead with the result and most striking detail. Do not bury the score.
- Quote the coach naturally where useful — paraphrase only if the quote is unclear.
- No clichés ("dug deep", "left it all on the field"). No invented stats.
- 2 to 5 paragraphs depending on source richness.

Output must be valid JSON with exactly two keys: "headline" (string, no period at end) and "body" (string, paragraphs separated by blank lines). Return JSON only — no preamble.`;

async function generateArticleForGame(gameId) {
  const game = db.prepare(`
    SELECT g.*, sp.name AS sport_name, s.name AS school_name, t.level
    FROM games g
    JOIN teams t ON t.id = g.team_id
    JOIN sports sp ON sp.id = t.sport_id
    JOIN schools s ON s.id = t.school_id
    WHERE g.id = ?
  `).get(gameId);
  if (!game) throw new Error(`Game ${gameId} not found`);

  const apiKey = settings.get('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { skipped: 'Anthropic API key not configured.' };

  // Pick source: most recent completed call, else most recent game_text.
  const call = db.prepare(`SELECT * FROM calls WHERE game_id = ? AND transcript IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(gameId);
  const text = db.prepare(`SELECT * FROM game_texts WHERE game_id = ? ORDER BY received_at DESC LIMIT 1`).get(gameId);

  let source, sourceContent, sourceLabel;
  if (call) { source = 'call'; sourceContent = call.transcript; sourceLabel = `Call transcript (${call.duration_seconds || 0}s)`; }
  else if (text) { source = 'text'; sourceContent = text.message_body; sourceLabel = 'Coach text message'; }
  else return { skipped: 'No call transcript or text yet.' };

  const thinSource = sourceContent.length < 80;

  const userPrompt = `Game context:
- School: ${game.school_name}
- Sport: ${game.sport_name} (${game.level})
- Date: ${game.game_date}
- Opponent: ${game.opponent || 'unknown'}
- OSAA result: ${game.result || 'not reported'}

Source: ${sourceLabel}${thinSource ? ' (THIN — coach gave very little; write a brief 2-paragraph recap and lean on game context. Do not invent quotes or details.)' : ''}

---
${sourceContent}
---

Return JSON: { "headline": "...", "body": "..." }`;

  const journalismPrompt = settings.get('journalism_prompt') || DEFAULT_PROMPT;
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic({ apiKey });

  const resp = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: journalismPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = resp.content?.[0]?.text || '';
  let parsed;
  try {
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    throw new Error(`Claude returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (!parsed.headline || !parsed.body) throw new Error('Claude response missing headline or body');

  const photo = db.prepare('SELECT id FROM photos WHERE game_id = ? ORDER BY received_at LIMIT 1').get(gameId);

  const info = db.prepare(`
    INSERT INTO articles (game_id, call_id, game_text_id, source, headline, body, status, thin_source, photo_id)
    VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
  `).run(gameId, call ? call.id : null, text ? text.id : null, source, parsed.headline, parsed.body, thinSource ? 1 : 0, photo ? photo.id : null);

  logEvent('article_generated', `Article ${info.lastInsertRowid} generated for game ${gameId} (source: ${source}${thinSource ? ', thin' : ''})`, gameId);
  return { article_id: info.lastInsertRowid };
}

module.exports = { generateArticleForGame };
