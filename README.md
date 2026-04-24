# Roseburg Sports Automation

Local high school sports coverage automation for a news outlet covering 4 schools in Roseburg, Oregon (Roseburg, Sutherlin, Glide, Oakland).

Pulls game schedules from OSAA, texts coaches for photos, calls coaches via AI voice agent for post-game interviews, generates article drafts from transcripts, and exposes a REST API for the news site.

**Single Node.js codebase. No N8N, no Airtable. SQLite. Light-mode dashboard.**

---

## Getting started

```bash
# 1. Install
npm install

# 2. Copy env, generate secrets
cp .env.example .env
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env

# 3. Migrate (creates SQLite DB and seeds 4 schools + sports)
npm run migrate

# 4. Create the first admin user
npm run create-admin <username> <password>

# 5. Run
npm start
# → http://localhost:3000
```

---

## What's where

```
src/
  server.js              # Express app, route mounts, session config
  db/
    index.js             # better-sqlite3 connection (WAL mode)
    migrate.js           # Tiny migration runner
    migrations/          # *.sql migrations (applied in order)
  lib/
    settings.js          # Settings store with AES-256-GCM for secrets
    crypto.js            # Encryption helpers
    log.js               # Notification log writer
    osaa.js              # OSAA API client + HTML coach scraper + sync
    twilio.js            # Outbound SMS, intro text, MMS download, signature validation
    retell.js            # Outbound call trigger + webhook payload handler
    articles.js          # Anthropic Claude → headline + body
    api-tokens.js        # API token generation, hashing, verification
    cron.js              # node-cron jobs (OSAA sync + game-day tick)
  middleware/auth.js     # requireAuth, requireAdmin
  routes/                # Dashboard pages + REST API + webhooks
views/                   # EJS templates (light mode, DM Sans)
public/css/styles.css    # All UI styling
data/                    # SQLite db + sessions (gitignored)
uploads/                 # Photos received via MMS (gitignored)
```

---

## Required external services

| Service | Why | Config |
|---|---|---|
| OSAA API | School schedules, contests, coaches | No API key — public; **note**: the live API and `/demo` CSV endpoints are protected by a Cloudflare browser challenge. The system tries both and logs failures gracefully. Operators can add teams/contacts manually as a fallback. |
| Twilio Programmable Messaging | Outbound photo-request SMS, inbound MMS via webhook | Account SID, Auth Token, phone number. Configure incoming webhook to `POST https://<your-host>/webhooks/twilio/incoming` |
| Retell AI | Post-game coach voice interviews | API key + Agent ID. Configure webhook to `POST https://<your-host>/webhooks/retell/call-complete` |
| Anthropic | Claude generates article drafts | API key |

All credentials can live in `.env` OR be pasted into the dashboard Settings page (where they're stored AES-256-GCM encrypted at rest).

---

## How it runs

- **Cron** (built-in via `node-cron`):
  - Every day at 6am and 6pm: full OSAA sync — pulls teams + schedules for all 4 schools.
  - Every minute: game-day tick — promotes "upcoming" games to "today", fires due photo requests, places due post-game calls (or sends text-only recap requests), retries failed calls once after 30 min, sends 2-hour nudges to text-only coaches who haven't replied.
- **Webhooks**:
  - `POST /webhooks/twilio/incoming` — receives MMS photos and SMS game info from coaches. Validates Twilio signature when an auth token is configured.
  - `POST /webhooks/retell/call-complete` — receives Retell call transcript + metadata. Validates HMAC signature.
- **REST API** at `/api/*` — bearer token auth (tokens managed in Settings → API tokens). See route source for full list.

---

## Deployment

The plan calls for a single VPS (~$5–20/mo) — DigitalOcean, Railway, or Fly.io are good fits. SQLite + local file uploads + long-running cron all assume a persistent filesystem and a continuously running process.

**Vercel does not fit cleanly** for this app:
- Vercel functions are ephemeral; SQLite + local uploads require persistent disk.
- `node-cron` requires a long-running process; on Vercel you'd switch to Vercel Cron Jobs.
- A port to Vercel would require swapping SQLite → Neon/Supabase/Postgres and uploads → Vercel Blob.

For Railway / Fly:
- Mount a persistent volume at `./data` (SQLite) and `./uploads` (photos).
- Set all env vars from `.env.example`.
- Open one HTTP port (default 3000).
- Configure inbound webhooks at Twilio + Retell to point at the public URL.

---

## Build phases

1. Foundation — Express + SQLite + auth + dashboard shell + Settings + Users
2. Schools, Teams & Contacts — seed 4 schools, OSAA team sync, contacts CRUD + CSV import
3. Schedule Engine — cron, Games page + detail view
4. Photo System — Twilio outbound + inbound webhook + MMS storage
5. Voice Calls — Retell trigger + webhook + retry logic
6. Article Generation — Anthropic + Articles queue + inline edit + photo picker
7. REST API — all endpoints + bearer token auth + token CRUD
8. Polish — Activity Log + error handling + end-to-end test

---

## Notes

- **OSAA Cloudflare**: the public OSAA API often returns Cloudflare's "Just a moment…" challenge (HTTP 403) to non-browser clients. The OSAA service detects this and degrades gracefully — failures land in the Activity Log; operators can add teams and contacts manually.
- **Test mode**: set `DISABLE_CRON=1` to skip the cron scheduler when running locally for development.
- **Photo storage**: local disk under `./uploads/<game_id>/<timestamp>.<ext>`. Low volume (~20–50/week max).
- **Security**: bcrypt for passwords; AES-256-GCM for stored credentials; httpOnly + sameSite cookies; Twilio + Retell signature validation; bearer tokens are SHA-256-hashed at rest.
