# Roseburg Sports Automation — Build Plan

## What This Is

A Node.js application that automates local high school sports coverage for a news outlet. It pulls game schedules from OSAA, texts coaches for photos, calls coaches via AI voice agent for post-game interviews, generates article drafts from transcripts, and exposes an API for a news site and other applications to consume.

## Core Principles

- **One codebase. No workflow tools.** No N8N, no Airtable, no Make.com. One Node.js app.
- **Simple wins.** SQLite for the database. Minimal dependencies. Only the tools that are necessary.
- **Clean, light-mode dashboard.** Simple, minimal UI. Password-protected, multi-user.
- **API-first.** The system exposes its own REST API. The news site and other external applications pull from this API. This system does not push to external platforms.

---

## Schools & Scope

Four schools in the Roseburg, Oregon area:

| School | Classification | Mascot |
|---|---|---|
| Roseburg High School | 6A | Indians |
| Sutherlin High School | 3A | Bulldogs |
| Glide High School | 3A | Wildcats |
| Oakland High School | 2A | Oakers |

**Coverage level:** Varsity only at launch. The data model must support JV and other sub-varsity levels for future expansion (the OSAA API provides levels: V, JV, JV2, FR, FR2).

**Sports covered (OSAA-sanctioned, varies by school size):** Football, Volleyball, Boys/Girls Soccer, Cross Country, Boys/Girls Basketball, Swimming, Wrestling, Baseball, Softball, Boys/Girls Golf, Track & Field, Boys/Girls Tennis, Boys/Girls Lacrosse. Not every school offers every sport — the system handles this dynamically based on what OSAA reports for each school.

**Estimated active teams at any point in a season:** 15-25 (sports are seasonal: fall/winter/spring).

---

## Tech Stack

| Layer | Tool | Purpose |
|---|---|---|
| Runtime | Node.js | Application server |
| Database | SQLite (via better-sqlite3 or Prisma) | Stores everything: contacts, games, articles, photos, settings |
| Web framework | Express.js or Fastify | Dashboard + API |
| Dashboard UI | Server-rendered HTML (EJS/Handlebars) or lightweight React | Clean, light-mode, password-protected |
| Game schedules | OSAA API (https://www.osaa.org/api) | Free, returns JSON. Covers schedules, contests, teams, schools |
| SMS/MMS | Twilio Programmable Messaging | Send photo request texts, receive photos via MMS webhook |
| Voice calls | Retell AI | Post-game coach interviews via phone |
| Article generation | Anthropic API (Claude) | Transcript → article draft using the outlet's journalism prompt |
| Scheduling/cron | node-cron or similar | Trigger daily schedule polls, game-day texts, post-game calls |
| File storage | Local filesystem (./uploads/) | Store received photos |
| Hosting | Single VPS (DigitalOcean, Railway, or Fly.io) | ~$5-20/month |

---

## Data Model

### Tables

**users**
- id (primary key)
- username (string, unique)
- password_hash (string, bcrypt)
- role (string: "admin" | "operator")
- created_at

**schools**
- id (primary key)
- osaa_id (integer, unique — from OSAA API)
- name (string — e.g. "Roseburg")
- classification (string — e.g. "6A")
- mascot (string)
- is_active (boolean, default true)

**sports**
- id (primary key)
- osaa_slug (string, unique — 3-char identifier from OSAA, e.g. "fbl", "bbx")
- name (string — e.g. "Football", "Boys Basketball")
- season (string: "fall" | "winter" | "spring")

**teams**
- id (primary key)
- school_id (foreign key → schools)
- sport_id (foreign key → sports)
- osaa_team_id (integer — from OSAA API)
- level (string: "V" | "JV" | "JV2" | "FR" | "FR2", default "V")
- is_active (boolean, default true)

**contacts**
- id (primary key)
- team_id (foreign key → teams)
- name (string)
- role (string — e.g. "Head Coach", "Assistant Coach")
- phone (string — E.164 format)
- email (string, nullable)
- is_primary (boolean, default true)
- is_active (boolean, default true)
- preference (string: "call" | "text_only", default "call" — whether this coach wants a post-game voice call or prefers to text in game info. Default is "call" because voice calls consistently produce richer information and better articles. "text_only" is the opt-out for coaches who don't want to be called.)
- onboarded_at (datetime, nullable — when intro text was sent)

**games**
- id (primary key)
- team_id (foreign key → teams)
- osaa_contest_id (integer, nullable — from OSAA API)
- opponent (string)
- location (string, nullable)
- game_date (date)
- game_time (time, nullable)
- status (string: "upcoming" | "today" | "in_progress" | "completed" | "cancelled")
- photo_requested (boolean, default false)
- photo_request_sent_at (datetime, nullable)
- call_requested (boolean, default false)
- call_completed (boolean, default false)
- call_retry_count (integer, default 0)
- created_at
- updated_at

**photos**
- id (primary key)
- game_id (foreign key → games)
- contact_id (foreign key → contacts — who sent it)
- file_path (string — local path to saved image)
- original_filename (string, nullable)
- mime_type (string)
- twilio_message_sid (string)
- received_at (datetime)

**calls**
- id (primary key)
- game_id (foreign key → games)
- contact_id (foreign key → contacts — who was called)
- retell_call_id (string — from Retell API)
- status (string: "initiated" | "in_progress" | "completed" | "failed" | "no_answer")
- duration_seconds (integer, nullable)
- transcript (text, nullable — full transcript from Retell)
- started_at (datetime, nullable)
- ended_at (datetime, nullable)
- created_at

**game_texts**
- id (primary key)
- game_id (foreign key → games)
- contact_id (foreign key → contacts — who sent it)
- message_body (text — the raw text message from the coach)
- twilio_message_sid (string)
- received_at (datetime)

**articles**
- id (primary key)
- game_id (foreign key → games)
- call_id (foreign key → calls, nullable)
- game_text_id (foreign key → game_texts, nullable — if article was generated from a text instead of a call)
- source (string: "call" | "text" — how the game info was gathered)
- headline (string)
- body (text)
- status (string: "draft" | "pending_review" | "approved" | "published" | "rejected")
- reviewed_by (foreign key → users, nullable)
- reviewed_at (datetime, nullable)
- published_at (datetime, nullable)
- photo_id (foreign key → photos, nullable — the photo attached to this article)
- created_at
- updated_at

**settings**
- id (primary key)
- key (string, unique)
- value (text — JSON string for complex values)

Settings to store: photo_text_offset_minutes (default: -30, meaning 30 min before game), call_offset_minutes (default: 45, meaning 45 min after game ends), per-sport timing overrides, journalism prompt text, Twilio/Retell/Anthropic API credentials.

**notification_log**
- id (primary key)
- type (string: "sms_sent" | "sms_received" | "call_initiated" | "call_completed" | "article_generated" | "article_approved" | "error")
- related_game_id (foreign key → games, nullable)
- message (text)
- created_at

---

## Automation Pipeline

### 1. Schedule Sync (runs twice daily, e.g. 6am and 6pm)

- Hit the OSAA API for each of the 4 schools.
- Pull all upcoming contests/schedules for active teams.
- Upsert games into the database. Mark new games as "upcoming".
- If a game is today, mark status as "today".
- If a game was yesterday and still marked "today", mark as "completed" (fallback — the call completion flow also does this).
- Log the sync in notification_log.

### 2. Photo Request SMS (runs on game day, timed per game)

- For each game with status "today" where photo_requested is false:
  - Calculate send time: game_time minus photo_text_offset_minutes (default 30 min before).
  - At the right time, send SMS via Twilio to the primary contact for that team.
  - Message template (configurable in settings): "Hi [Coach Name], it's [Outlet Name]! [Team] plays [Opponent] today. Can you send us a game photo when you get a chance? You can also text us the score and any highlights after the game. Just reply to this number. Thanks!"
  - Set photo_requested = true, photo_request_sent_at = now.

### 3. Incoming Message Handling (Twilio webhook, always listening)

- Twilio POST webhook at /webhooks/twilio/incoming.
- Match the incoming phone number to a contact in the database.
- Determine the active game for that contact's team today.

**If the message has media (MMS):**
- Download the image from Twilio's media URL and save to ./uploads/[game_id]/[timestamp].[ext].
- Create a photo record linked to the game and contact.
- Reply: "Got it, thanks Coach!"

**If the message is text only (SMS with no media):**
- Save the message body as a game_text record linked to the game and contact.
- Reply: "Got it, thanks Coach! We'll use this for the recap."
- Trigger article generation from this text (same as step 5, but using the text message as the source instead of a call transcript).

**If the message has both text and a photo:**
- Save the photo as above.
- Save the text as a game_text record.
- Reply: "Got the photo and the info, thanks Coach!"
- Trigger article generation from the text.

### 4. Post-Game Voice Call (timed after game ends)

- For each game with status "today" or "completed" where call_requested is false:
  - Look up the primary contact for that team.
  - **If the contact's preference is "text_only":** skip the call entirely. If a game_text has already been received, article generation proceeds from that. If no text has been received by the call window, send a structured follow-up SMS with specific questions (template configurable in settings, default below):

    "Hey Coach [Name]! Quick recap for the [Opponent] game:
    1. Final score?
    2. Any standout players or big moments?
    3. Where does this put you in the season?
    4. Big games coming up?
    Reply here and we'll write it up. Thanks!"

    Mark call_requested = true (so it doesn't keep trying). If no reply within 2 hours, send one nudge: "No worries if you're busy Coach — just the score is helpful if you get a sec!" Then stop.
  - **If the contact's preference is "call":** proceed with the voice call as below.
  - **If a game_text has already been received** (the coach texted in results before the call window): skip the call. An article is already being generated from the text. Mark call_requested = true.
  - Calculate call time: game_time + estimated_game_duration + call_offset_minutes.
  - Estimated game duration by sport: Football ~3hr, Basketball ~2hr, Soccer ~2hr, Volleyball ~2hr, Baseball/Softball ~2.5hr, etc. Store these defaults in settings, configurable.
  - At the right time, trigger an outbound call via Retell AI API to the primary contact.
  - Set call_requested = true.

**Retell AI Agent Configuration:**

The agent should have a warm, conversational tone. The interview script covers:

1. Greeting — identify yourself as calling from [Outlet Name] about tonight's [Sport] game.
2. Ask for the final score.
3. Ask how the team played overall — what went well, what they want to improve.
4. Ask about any standout individual performances or noteworthy moments.
5. Ask where the team stands in the season — record, league standing.
6. Ask about upcoming games or important matchups.
7. Ask if there's anything else they'd like the community to know.
8. Thank them and end the call.

The agent should be able to handle short answers, follow up naturally, and keep the call to 3-5 minutes.

**Retell webhook** at /webhooks/retell/call-complete:
- Receives the transcript and call metadata when the call ends.
- Updates the call record with transcript, duration, status.
- Triggers article generation (step 5).

**Retry logic:**
- If the call fails or goes unanswered, wait 30 minutes and retry once.
- After one retry, mark as "failed" and flag in the dashboard for the operator.
- Operator can manually trigger a retry from the dashboard.

### 5. Article Generation (triggered after call completes OR text is received)

- Determine the source:
  - **From a call:** use the call transcript.
  - **From a text:** use the game_text message body.
- Send the source content to the Anthropic API (Claude) with the journalism prompt.
- The prompt should include: the source content (transcript or text message), the game context (team, opponent, date, sport, school), the source type (so Claude can adjust — a brief text with just a score gets a short 2-3 paragraph recap, a text with detailed info gets a medium article, a full 5-minute call transcript gets a full-length feature recap), and the journalism style guide.
- If the source is very thin (e.g. just "Won 35-7"), Claude should still generate a short usable article using the game context (opponent, sport, where they are in the season from OSAA data). Flag it in the dashboard as "thin source — may need editing."
- Claude returns a headline and article body.
- Save as an article record with status "pending_review", source = "call" or "text", and the appropriate call_id or game_text_id.
- Notify the operator.

### 6. Operator Review (dashboard)

- Operator sees pending articles in the dashboard.
- Can edit the headline and body inline.
- Can attach or swap the photo.
- Can approve (status → "approved") or reject.
- Approved articles become available via the API.

---

## Dashboard

### Design Direction

- **Light mode only.** Clean white/light gray background.
- **Minimal and utilitarian.** No gradients, no flashy animations. Feels like a calm newsroom tool.
- **Typography:** One good sans-serif font. Something clean like "DM Sans" or "Plus Jakarta Sans" from Google Fonts. Nothing generic like Arial/Inter.
- **Color palette:** White background (#FAFAFA or similar), dark text (#1A1A1A), one accent color for actions/highlights (a muted blue or teal), red for errors/alerts, green for success states.
- **Layout:** Sidebar navigation on the left, content area on the right. No clutter.

### Pages

**Login**
- Simple centered card. Username + password fields. Submit button.

**Dashboard / Home**
- At-a-glance summary: today's games, pending articles count, recent activity feed.
- Quick links to games needing attention (missed calls, no photos).

**Games**
- Filterable list/table: by school, sport, date range, status.
- Each game row shows: date, school, sport, opponent, photo status (icon), call status (icon), article status.
- Click into a game for full detail: game info, photos received, call transcript, generated article.

**Articles**
- Queue view: pending review at top, then approved, then published.
- Inline editing: click to edit headline/body directly.
- Approve / reject buttons.
- Photo attachment picker (from photos received for that game, or upload manually).

**Contacts**
- Table of all coaches: name, school, sport, phone, preference (call / text-only), primary/backup, active/inactive.
- Add / edit / deactivate contacts.
- Toggle contact preference between "call" and "text_only" — text-only coaches never get voice calls, they get a follow-up text instead.
- "Send intro text" button for onboarding a new coach.
- Bulk import via CSV.

**Schools & Teams**
- View schools and their teams. Mostly auto-populated from OSAA sync.
- Toggle teams active/inactive.
- Configure per-sport settings (timing offsets, game duration estimates).

**Settings**
- API credentials (Twilio, Retell, Anthropic) — stored encrypted.
- Default timing settings (photo text offset, call offset).
- Journalism prompt (editable text area).
- Notification preferences (who gets notified when articles are ready).
- User management (add/remove dashboard users, reset passwords).

**Activity Log**
- Chronological feed of system events: texts sent, calls made, articles generated, errors.
- Filterable by type and date.

---

## REST API

The system exposes a REST API for the news site and other external applications. All endpoints return JSON.

### Authentication

API requests use a bearer token. Tokens are generated in the dashboard under Settings. Simple static tokens (not JWT) — stored hashed in the database. Multiple tokens can be active (one per consuming application).

### Endpoints

**Articles**

- `GET /api/articles` — List articles. Supports query params: status (approved, published), school, sport, since (datetime), limit, offset.
- `GET /api/articles/:id` — Single article with full detail (headline, body, game info, photo URL).
- `PATCH /api/articles/:id` — Update article status (e.g., mark as "published" after the news site has consumed it).

**Games**

- `GET /api/games` — List games. Supports query params: school, sport, status, date_from, date_to, limit, offset.
- `GET /api/games/:id` — Single game with detail (score, photos, call info, article).

**Photos**

- `GET /api/photos/:id/file` — Serve the actual image file.
- `GET /api/games/:id/photos` — List photos for a game.

**Schools & Teams**

- `GET /api/schools` — List schools.
- `GET /api/schools/:id/teams` — List teams for a school.

**Schedule**

- `GET /api/schedule` — Upcoming games across all schools. Supports date_from, date_to filters.

**Health**

- `GET /api/health` — Returns system status, last OSAA sync time, counts of pending items.

### API Response Format

```json
{
  "data": { ... },
  "meta": {
    "total": 42,
    "limit": 20,
    "offset": 0
  }
}
```

Error responses:
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Article not found"
  }
}
```

---

## Webhooks (Incoming)

### Twilio SMS/MMS Webhook

- **URL:** POST /webhooks/twilio/incoming
- **Purpose:** Receive incoming texts (game info) and photos from coaches.
- **Security:** Validate Twilio request signature.
- **Logic:** Match sender phone → contact → team → active game for today. If MMS, save photo. If SMS text body, save as game_text and trigger article generation. If both, save both. Reply with confirmation.

### Retell AI Call Completion Webhook

- **URL:** POST /webhooks/retell/call-complete
- **Purpose:** Receive transcript and call metadata after a voice call ends.
- **Security:** Validate Retell webhook signature.
- **Logic:** Match call ID → call record → game. Save transcript. Trigger article generation.

---

## Coach Onboarding Flow

When a new contact is added in the dashboard and "Send intro text" is clicked:

1. Send SMS: "Hi [Name], this is [Outlet Name]! We're covering [School] [Sport] this season. On game days, we'll text you asking for a quick photo. After the game, we may call for a brief recap — or if you prefer, you can just text us the score and highlights instead. You can always text photos or game info to this number anytime. Reply STOP to opt out. Thanks for helping us cover the team!"
2. Record onboarded_at timestamp.

---

## Environment Variables / Configuration

```
# Server
PORT=3000
SESSION_SECRET=<random string>

# Database
DATABASE_PATH=./data/sports.db

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Retell AI
RETELL_API_KEY=
RETELL_AGENT_ID=

# Anthropic
ANTHROPIC_API_KEY=

# OSAA
OSAA_API_BASE_URL=https://www.osaa.org/api

# File storage
UPLOAD_DIR=./uploads
```

---

## Build Order

Build and test each piece incrementally. Each phase should be functional before moving to the next.

### Phase 1 — Foundation
1. Initialize Node.js project with Express/Fastify.
2. Set up SQLite database with all tables (use migrations).
3. Build authentication (login, session management, password hashing).
4. Build the dashboard shell: layout, sidebar nav, login page.
5. Build the Settings page (store/retrieve config values).
6. Build User management (add/remove users).

### Phase 2 — Schools, Teams & Contacts
7. Seed the 4 schools into the database.
8. Build the OSAA API integration — pull teams, schedules, and coach/staff names for each school. OSAA team pages list head coach and assistant coach names per team. Use these to pre-populate the contacts table with names and roles so the operator only needs to fill in phone numbers (obtained from each school's Athletic Director).
9. Build the Schools & Teams dashboard page.
10. Build the Contacts dashboard page (CRUD, CSV import, intro text button). Show pre-populated coach names with empty phone fields highlighted so the operator knows what still needs to be filled in.

### Phase 3 — Schedule Engine
11. Build the OSAA schedule sync job (cron, twice daily).
12. Build the Games dashboard page (list, filter, detail view).
13. Test: verify games are populating automatically from OSAA data.

### Phase 4 — Photo System (Twilio)
14. Set up Twilio account, buy a phone number.
15. Build outbound SMS sending for photo requests.
16. Build the Twilio incoming webhook (receive MMS, save photos).
17. Wire the photo request trigger to the schedule engine (game-day timing).
18. Test: send a photo request, text back a photo, see it in the dashboard.

### Phase 5 — Voice Calls (Retell AI)
19. Set up Retell AI account, configure the interview agent with the script.
20. Build outbound call triggering via Retell API.
21. Build the Retell webhook to receive transcripts.
22. Wire the call trigger to the schedule engine (post-game timing).
23. Build retry logic (one retry after 30 min, then mark failed).
24. Test: trigger a call, complete the interview, see transcript in dashboard.

### Phase 6 — Article Generation
25. Build the Anthropic API integration — send transcript + context + journalism prompt → receive headline + body.
26. Save generated articles to database with status "pending_review".
27. Build the Articles dashboard page (queue, inline editing, approve/reject).
28. Build operator notification (dashboard badge count + optional SMS/email).
29. Test: full pipeline — game → photo → call → transcript → article → review.

### Phase 7 — REST API
30. Build all API endpoints (articles, games, photos, schools, teams, schedule, health).
31. Build API token authentication.
32. Build API token management in the dashboard Settings page.
33. Test: fetch approved articles from the API with a bearer token.

### Phase 8 — Polish & Harden
34. Activity log page in dashboard.
35. Error handling and logging throughout.
36. Dashboard home page with at-a-glance summary.
37. Ensure all timing/offset settings are configurable per-sport in the dashboard.
38. Test full end-to-end with real OSAA data for all 4 schools.

---

## Notes for the Builder

- **OSAA API — DETAILED INTEGRATION GUIDE:**

  **Base URL:** `https://www.osaa.org/api` — returns JSON arrays. No API key is documented; the API appears to be public. The docs page is at https://www.osaa.org/api (may require browser access to read fully). If the API returns 403, try with a standard User-Agent header and fall back to the `/demo/` endpoints described below.

  **Known school IDs (from OSAA URLs):**
  | School | OSAA School ID | OSAA URL |
  |---|---|---|
  | Roseburg | 72 | https://www.osaa.org/schools/72 |
  | Sutherlin | 9 | https://www.osaa.org/schools/9 |
  | Glide | 174 | https://www.osaa.org/schools/174 |
  | Oakland | 258 | https://www.osaa.org/schools/258 |

  **API Nodes & Endpoint Patterns:**

  - **Activities:** Lists all OSAA-sanctioned sports. Each has a 3-character slug (e.g. `fbl` = Football, `bbx` = Boys Basketball, `gbx` = Girls Basketball, `vbl` = Volleyball, `sbl` = Softball, `bbl` = Baseball, etc.).
    - `GET /api/activities` — list all activities

  - **Schools:** School info by ID.
    - `GET /api/schools/{school_id}` — single school

  - **Teams:** A team is a specific school + sport + level + year. Each team has a unique team ID.
    - `GET /api/schools/{school_id}/teams` — list teams for a school (filter by year/activity as needed)
    - `GET /api/teams/{team_id}` — single team detail

  - **Schedules:** A schedule is the list of contests for a given team.
    - `GET /api/teams/{team_id}/schedule` — returns array of contests for that team
    - The `/demo/teams/{team_id}/schedule` endpoint returns CSV-formatted schedule data (confirmed working). This is a fallback if the JSON API has access issues.

  - **Contests:** A contest is a single game between two teams.
    - `GET /api/contests/{contest_id}` — single contest detail
    - `GET /api/contests?activity={slug}&date={YYYY-MM-DD}` — contests for an activity on a date
    - Contest statuses: `SCHD` (scheduled), `PPD` (postponed), `LIVE` (in progress), `DONE` (completed, score entered), `DEL` (deleted/cancelled)

  - **Contest data includes:** contest ID, activity, status, type (League/Non-League/Playoff), date, time, home team, away team, location, result (score string like "3-0, Molalla"), dismiss/depart/return times.

  **Sync strategy:**
  1. On first run: for each of the 4 schools, fetch all teams for the current school year. Store team IDs.
  2. Twice daily: for each stored team ID, fetch the schedule. Upsert contests into the games table.
  3. Map OSAA contest statuses → our game statuses: `SCHD`/`PPD` → "upcoming", `LIVE` → "in_progress", `DONE` → "completed", `DEL` → "cancelled".
  4. Use the OSAA contest `Result` field to store scores when games are marked DONE — this gives you the score even if the coach call doesn't happen.
  5. If the OSAA API's JSON endpoints return 403, use the `/demo/teams/{team_id}/schedule` CSV endpoint as a fallback and parse the CSV.

  **Important:** OSAA data is entered by schools. Scores are required by 10pm the day of the contest but may be late. The schedule sync should handle missing/late data gracefully.
- **Retell AI:** Use their REST API to create outbound phone calls. The agent is configured in Retell's dashboard (no-code). The app just triggers calls and receives webhooks. Docs: https://docs.retellai.com
- **Twilio:** Standard Programmable Messaging API. MMS receiving requires a webhook URL configured on the Twilio phone number. Docs: https://www.twilio.com/docs/messaging
- **Anthropic API:** Standard Messages API. Model: claude-sonnet-4-20250514 is fine for article generation. Keep it simple — one API call per article.
- **Photos:** Store locally on disk. Serve via the API. Don't over-engineer storage — this is low volume (~20-50 photos per week max).
- **Dashboard design:** Light mode, clean, minimal. Think "calm newsroom tool." White/light gray background, one accent color, no visual noise. Use a Google Font like DM Sans or Plus Jakarta Sans. No dark mode needed.
- **Security:** Hash passwords with bcrypt. Validate Twilio webhook signatures. Store API keys encrypted at rest. Use httpOnly session cookies for the dashboard. Rate-limit the API.
- **The journalism prompt** is provided separately by the operator and stored in Settings. The builder does not need to write it — just provide the text area to paste it in and use it when calling the Anthropic API.
