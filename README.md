# IEK Online Voting System

A voter turnout tracking system for Institution of Engineers of Kenya (IEK) elections, backed by **Neon PostgreSQL** and deployed as **Vercel Functions** — real, shared, persistent data that every visitor sees identically, themed in the colors of the Kenyan flag.

![Status](https://img.shields.io/badge/status-active-brightgreen) ![DB](https://img.shields.io/badge/database-Neon%20PostgreSQL-00e599) ![Deploy](https://img.shields.io/badge/deploy-Vercel-black) ![License](https://img.shields.io/badge/license-MIT-black)

---

## What changed from the localStorage version

This is a full rewrite of the earlier prototype. The old version stored engineers in each browser's `localStorage`, so every device had its own independent copy of "who voted." That's gone. Now:

- All data lives in a real **Neon PostgreSQL** database.
- The frontend (`script.js`) talks to a real API (`/api/*`, Vercel Functions) instead of `localStorage`.
- Every action — register, vote, undo, edit remarks, delete, reset — is a database write, visible to **every** visitor immediately (after a refresh/re-fetch).
- Every mutating action is recorded in an `audit_log` table, and every vote is recorded in a `votes` table, independent of the engineers table's live `voted` flag.

**⚠️ Before you treat this as ready for a real election, read [Security note](#security-note-please-read) below.** The API endpoints that add/edit/delete/vote have no authentication — anyone who finds your URL can call them directly (bypassing the UI). This matches exactly what was asked for in this rewrite (frontend + DB + API, no login system), but it's a real gap for a genuine election and is called out explicitly rather than glossed over.

---

## Architecture

```
Browser (index.html/script.js)
        │  fetch() — JSON over HTTPS
        ▼
Vercel Functions (/api/*.js)
        │  @neondatabase/serverless (HTTP-based Postgres driver)
        ▼
Neon PostgreSQL (engineers, votes, audit_log tables)
```

No Express server, no `pg` connection pooling, no client-side database credentials — each `/api/*.js` file is an independent serverless function that opens a lightweight HTTP connection to Neon per request via `@neondatabase/serverless`, which is purpose-built for this (see [Note on dependencies](#note-on-dependencies) below).

---

## Project Structure

```
IEK-VOTING-FULL/
├── index.html              # Main page (dashboard, form, table, connection banner)
├── styles.css              # Kenyan theme, responsive layout, animations
├── script.js               # Frontend logic — fetch()-based, no localStorage
├── schema.sql               # Run once against Neon to create tables
├── images/
│   ├── iek-logo.jpg           # Official IEK logo (used in the header)
│   └── stariko-nyamori.jpg    # Candidate portrait (used on the candidate card)
├── api/                      # 11 function files total — see "Serverless function count" below
│   ├── _db.js                # Shared Neon connection (lazy-initialized)
│   ├── _utils.js              # CORS, audit logging, IP extraction, error helper
│   ├── _config.js             # Election window (start/end) + phase logic
│   ├── engineers.js           # GET/POST (collection) + PUT/DELETE via ?id= — /api/engineers[/:id]
│   ├── candidates.js          # GET/POST (collection) + DELETE/vote via ?id=&vote= — /api/candidates[/:id[/vote]]
│   ├── history.js             # Calls + remarks via ?kind=calls|remarks — /api/contact-calls, /api/remarks
│   ├── reports.js             # Urgent + analytics via ?type=urgent|analytics — /api/urgent, /api/analytics
│   ├── meta.js                # Audit log + election status via ?type=audit|status — /api/audit-log, /api/election-status
│   ├── stats.js               # GET — total/voted/notVoted/turnout/needsFollowUp
│   ├── reset-votes.js         # POST — reset all engineers to "not voted"
│   ├── export.js              # GET — CSV/Excel download, ?type=engineers|stats|candidates|calls|remarks
│   ├── import.js              # POST — bulk-add engineers from CSV text
│   ├── sms.js                 # GET (log)/POST (send)/?kind=drafts|replies|balance — Sozuri SMS, see "SMS Draft Center" below
│   └── sms-reply.js           # POST — inbound Sozuri webhook for two-way SMS replies
├── setup.js                  # One-command bootstrap: tables + sync + git push + deploy
├── fix-database.js           # Cleanup + clean re-import (see git history for context)
├── .env.example             # Template for required env vars (committed)
├── .env.local                # Your real local DATABASE_URL (gitignored)
├── package.json
├── vercel.json
├── .gitignore
├── DEPLOY.bat / deploy.ps1   # One-click git add/commit/push
└── README.md
```

**Note on dynamic routes:** `/api/engineers/:id`, `/api/candidates/:id`, `/api/candidates/:id/vote` etc. were originally separate bracket-folder files (`api/engineers/[id].js`) — the standard Vercel convention — but they 404'd in production on this project. Rather than keep debugging Vercel's zero-config route detection, they were folded into their collection file (`engineers.js`, `candidates.js`) with `vercel.json` rewrites forwarding the ID as a query parameter (`/api/engineers/:id` → `/api/engineers?id=:id`). Browser-facing URLs are unchanged either way.

### Serverless function count (Vercel Hobby plan limit: 12)

This project hit that limit directly: adding 4 new endpoints in one pass (16 total function files) silently dropped the newest 4 from deployment — no build error, just 404s on exactly those routes, because the build log doesn't necessarily surface a warning about it prominently. If you add more endpoints later and see the exact same "everything old still works, everything new 404s" symptom, **check the function count first** before assuming a code bug:

```bash
# Count actual function files (excludes _-prefixed helpers, which don't count):
find api -maxdepth 1 -name "*.js" | grep -v "/_" | wc -l
```

Currently **11** (1 under the limit). The pattern used to consolidate here — one file per *resource*, dispatching on `req.query.id` for single-item ops and a `?type=`/`?kind=` marker for otherwise-unrelated GET reports, with `vercel.json` rewrites keeping the original URLs intact — is the way to add more without hitting this again. `api/sms.js` alone covers send/log/drafts/replies/balance this way rather than becoming 5 separate files. `api/sms-reply.js` stayed a separate file from `sms.js` since it's a webhook with a different caller (Sozuri, not the browser) and a different auth shape — but it does double duty internally, also handling the delivery-status webhook (`/api/sms-status` rewrites to `/api/sms-reply?kind=status`) rather than becoming a 12th file. If you outgrow 12 functions even with consolidation, upgrading to a paid Vercel plan removes the limit.

---

## Quickest path: `node setup.js`

If `.env.local` already has your real Neon `DATABASE_URL` in it, one command does steps 3–8 below in order: installs dependencies, connects to Neon, creates/syncs tables, verifies `package.json`/`vercel.json`, then commits and pushes to GitHub (which triggers Vercel's auto-deploy), with a best-effort `vercel --prod` if the Vercel CLI is installed and logged in. It does **not** insert any placeholder data — see [Load your real voter register](#load-your-real-voter-register) below for that.

```bash
node setup.js
```

**Why `setup.js` never contains your password:** it reads `DATABASE_URL` from `.env.local` at runtime instead of having it hardcoded. That file commits and pushes itself to GitHub as part of what it does — anything hardcoded inside it would get pushed to your repo right along with it, permanently, in git history. Keeping the real connection string only in the git-ignored `.env.local` is what makes it safe for `setup.js` itself to be committed. The script also refuses to commit if it ever detects a `.env`/`.env.local` file staged, as a second layer of protection.

It's also fully idempotent — re-run it any time (e.g., after adding rows to the DB or pulling new commits) and it will skip anything already done (existing tables, existing engineers, a clean working tree) rather than erroring out.

---

## 1. Set up Neon PostgreSQL

1. Go to **https://neon.tech** and sign up (the free tier is enough for this).
2. Create a new project (any name, any region close to your Vercel deployment region).
3. In the Neon Console, open **Connection Details** and copy the **pooled connection string** (it looks like `postgresql://user:password@ep-xxxx-pooler.region.aws.neon.tech/dbname?sslmode=require`). Use the *pooled* string, not the direct one — it's the one meant for serverless functions.
4. Open the **SQL Editor** in the Neon Console, paste in the contents of [`schema.sql`](schema.sql), and run it. This creates the `engineers`, `votes`, and `audit_log` tables.

> Alternative: if you have `psql` installed locally, run `psql "$DATABASE_URL" -f schema.sql` instead of using the web SQL Editor.

### Schema (as created by `schema.sql`)

```sql
CREATE TABLE engineers (
    id SERIAL PRIMARY KEY,
    iek_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    voted BOOLEAN DEFAULT FALSE,
    remarks TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE votes (
    id SERIAL PRIMARY KEY,
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
    voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    voter_ip VARCHAR(50)
);

CREATE TABLE audit_log (
    id SERIAL PRIMARY KEY,
    action VARCHAR(50),
    engineer_id INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    user_ip VARCHAR(50)
);
```

**Two deliberate changes from the exact DDL originally specified:** `votes.engineer_id` now has `ON DELETE CASCADE` and `audit_log.engineer_id` has `ON DELETE SET NULL`. Without these, deleting an engineer would fail with a foreign-key violation the moment they had a vote or any audit history — which, in a real election, is most engineers. See the comments in `schema.sql` for the reasoning.

---

## 2. Configure environment variables

### Local development
1. Copy the template: your `.env.local` file already exists with a placeholder — open it and replace the placeholder with your real Neon connection string from step 1.3 above:
   ```
   DATABASE_URL=postgresql://your-real-connection-string-here
   ```
2. `.env.local` is already in `.gitignore` — it will never be committed.

### Production (Vercel)
1. Go to your Vercel project → **Settings → Environment Variables**.
2. Add `DATABASE_URL` with the same Neon connection string, scoped to **Production** (and Preview, if you want preview deployments to hit the same database — or create a second Neon branch/database for previews).
3. Redeploy (or push a commit) after adding env vars — Vercel Functions only pick up new env vars on a fresh deployment.

You can also sync env vars with the Vercel CLI:
```bash
npm i -g vercel
vercel link
vercel env pull .env.local
```

---

## 3. Install dependencies & run locally

```bash
npm install
npm i -g vercel   # if not already installed
vercel dev
```

`vercel dev` serves both the static frontend **and** the `/api/*` functions locally with your `.env.local` variables loaded — this is required for the app to work locally (a plain static file server like `npx serve` will load the HTML/CSS/JS but every `fetch('/api/...')` call will 404).

### Note on dependencies

The original ask listed `express`, `pg`, and `cors` as dependencies. This project ships with only **`@neondatabase/serverless`** and doesn't include those three. Reasoning:

- **Express** — Vercel Functions in the `/api` folder are independent per-file handlers, not routes mounted on one Express app; there's no server object for Express middleware to attach to. Adding it would be dead weight.
- **`pg`** — this uses raw TCP connections, which don't pool well across many short-lived serverless invocations. `@neondatabase/serverless` is Neon's own HTTP-based driver, purpose-built for exactly this environment, and is what Vercel's own storage guidance recommends.
- **`cors`** — that's Express middleware. CORS headers are set manually in `api/_utils.js` (`applyCors`) instead, which is simpler for standalone handler functions.

If you actually want a unified Express server (e.g. to run this outside Vercel too), say so and it can be restructured — but as shipped, those three packages would sit unused in `node_modules`.

---

## 4. Load your real voter register

There is no demo/sample data seeding step — it was deliberately removed once the real register was imported (an earlier version of this app auto-seeded 8 placeholder engineers named IEK001–IEK008 on every `node setup.js` run, which meant deleting them from production only for them to reappear on the next deploy; that seeding code no longer exists at all).

To load your actual voters:
- **One at a time**: click **+ Add Engineer** in the app.
- **In bulk**: click **Import CSV** and select your voter register file — see [Bulk CSV import](#bulk-csv-import) below for the expected format. `data/iek-voter-register-import.csv` in this repo (gitignored — it's real people's data, never committed) is the cleaned register already used for this election.

If you ever want throwaway test rows while developing, add them by hand through the UI and delete them when done — don't reintroduce an automated seeding step, since it's exactly the kind of thing that quietly ends up live in front of real voters if forgotten.

---

## 5. Deploy to Vercel

```bash
vercel --prod
```

or push to GitHub (Vercel's Git integration auto-deploys), or double-click `DEPLOY.bat` if this repo is already linked to GitHub + Vercel — see [Deployment scripts](#deployment-scripts) below.

Vercel auto-detects the `/api` folder as Functions; no build step is required for the static frontend (`outputDirectory` is set to `.` in `vercel.json`).

---

## 6. SMS Draft Center (optional)

Not a Vercel Marketplace integration — I checked (`vercel integration discover --category messaging`) and the only native SMS/messaging product listed is Resend, which is email-only. SMS here is a direct integration with **Sozuri**, wired up the same way `DATABASE_URL` is: credentials read from environment variables, no SDK, just `fetch()` to their REST API.

**The request/response contract in `api/sms.js` is verified** against Sozuri's official docs (`sozuri.net/docs/text`, `/docs/authentication`, `/docs/webhooks`, `/docs/2way`) **and a real send** (2026-08-02 — sent successfully to a real engineer, HTTP 200 with a `messageId` back).

**Two things learned the hard way, both now fixed in code:**
1. `SOZURI_PROJECT_ID` must be the project's dashboard **display name** (e.g. `IEK ELECTION`), not the opaque project ID string — the ID gets a flat `401 AUTHENTICATION_FAILED` from Sozuri, no matter how correct everything else is.
2. **Sozuri returns HTTP 200 even when a request fails** (e.g. bad recipient) — the real error lives in `messageData.message` with no `recipients` array. Checking `response.ok` alone silently treats this as success. `sendViaSozuri()` in `api/sms.js` now checks for a real `recipients[0]` entry, not just the HTTP status.

If a send still fails: the **SMS Draft Center**'s result banner has a **"Show last error detail"** disclosure with the exact outgoing request (API key redacted) and Sozuri's exact response — no server log access needed to debug it.

**Before any bulk send to real voters: select just one engineer (ideally your own phone) and send one test message first.**

### Setup

1. Sign up at Sozuri (https://sozuri.net) and grab your project's **display name** (dashboard, not the opaque ID — see above) and **API Key**.
2. Add to `.env.local` (local) and Vercel → Settings → Environment Variables (production):
   ```
   SOZURI_PROJECT_ID=your-project-display-name
   SOZURI_API_KEY=your-api-key
   SOZURI_SENDER=STARIKO
   SOZURI_CALLBACK_KEY=          # optional, see "Two-way SMS" below
   ```
   `SOZURI_SENDER` is the alphanumeric sender ID recipients see. Most SMS gateways cap this at **11 characters** (the GSM alphanumeric sender ID limit) — that's why this project uses `STARIKO` rather than the longer `IEKVOTESTARIKOO`.
3. Run `node setup.js` to create the `sms_log`, `sms_drafts`, and `sms_replies` tables, then deploy.
4. Send one test SMS to your own number from the **SMS Draft Center** section before any bulk send.

### How it works — SMS Draft Center

Everything SMS-related lives in one section (**📱 SMS Center** in the nav bar), not scattered across modals:

- **Composer**: pick one of the 3 built-in templates or write a custom message. Use `[Name]` anywhere in the text and it's substituted with each recipient's actual name at send time — so one message personalizes itself across everyone selected.
- **Drafts**: **💾 Save Draft** stores the current message (prompts for a short name); the **Saved Drafts** dropdown reloads it later. Backed by the `sms_drafts` table via `/api/sms?kind=drafts`.
- **Recipients**: a scrollable checklist of every engineer (name + phone), with quick-select buttons — **Select All**, **Select Not Voted**, **Select Confirmed**, **Select Not Reachable**, **Clear All** — plus voter-status/call-status filters and a search box to narrow the list before selecting. Engineers with no phone on file are shown disabled (can't be selected). Clicking **📱 SMS** on a row in the main table, or **📱 SMS Selected** in the bulk-action bar, jumps here with just those engineers pre-selected.
- **Sending**: **📤 Send to Selected** sends one request per recipient (not one bulk-array call) — this is deliberate, since it's what makes per-recipient `[Name]` personalization possible and drives the live "Sending: X/Y" progress bar. Up to 3 sends run concurrently. A result summary (✅ sent / ❌ failed / ⚠️ no usable phone) appears when it finishes.
- **Phone normalization**: your voter register has mixed formats (`"0703-142385"`, `"0712345678"`, etc.) — `toSozuriMsisdn()` in `api/sms.js` normalizes every number to bare-digit `254...` form (no `+`, per Sozuri's expected format) before sending. Numbers it can't confidently parse are logged as `invalid_phone` and skipped rather than guessed at.
- **SMS Log**: every send attempt (sent/failed/invalid_phone) is logged inline at the bottom of the section, and per-engineer in the **Details** modal's history timeline alongside calls and remarks. Delivery-status callbacks (see below) update the same rows once Sozuri reports what actually happened downstream.
- **Credits**: Sozuri has **no API endpoint for account balance/credits** (confirmed against their docs — "each project gets its own ... credit balance" but it's dashboard-only). The **💰 Credits** badge says so plainly rather than faking a number — check the actual balance on your Sozuri dashboard.

### Two-way SMS (replies + delivery status)

Two separate webhooks, both handled by `api/sms-reply.js` (one file, `?kind=` dispatch — same consolidation pattern as `api/sms.js`, see [Serverless function count](#serverless-function-count-vercel-hobby-plan-limit-12)):

| Set this in Sozuri dashboard → Manage API → Callback URLs | Points to |
|---|---|
| Inbound / 2-way SMS webhook | `https://<your-domain>/api/sms-reply` |
| Delivery status / callback URL | `https://<your-domain>/api/sms-status` |

**Inbound replies**: every reply is logged to `sms_replies`, matched to an engineer by phone (last 9 digits, tolerant of format differences). If the reply contains **YES** or **VOTE** (case-insensitive) and that engineer isn't already `confirmed`, it auto-logs a `contact_calls` row (caller: "SMS Reply (Auto)") and sets `contact_status = 'confirmed'` — exactly like a real call would, so it shows up in Analytics/Urgent/Agenda automatically. **💬 View Replies** in the SMS Log area shows the raw inbox, including unmatched numbers and which replies triggered an auto-confirm.

**Delivery status**: Sozuri POSTs `{ messageId, status, network, ... }` asynchronously as each message progresses past the initial "accepted" response. The matching `sms_log` row (by `provider_message_id`) gets its `status`/`provider_status` updated — `"success"` maps to `sent`, anything else (`network_failure`, `delivery_impossible`, `absent_subscriber`, `unknown_error`) maps to `failed`.

**Optional verification**: register an **Auth Key** under Sozuri dashboard → Manage API → Callback URLs, then set `SOZURI_CALLBACK_KEY` to the same value — both webhooks then reject any callback whose `authKey` field doesn't match. Left unenforced if you don't set it, so this works before you've configured that.

### Cost (verify current pricing yourself — this is not live data)

Confirm current per-SMS pricing on your Sozuri dashboard before budgeting — I have no way to fetch live pricing. Messages over 160 characters bill as multiple SMS parts; the character counter in the composer shows this before you send.

---

## API Reference

All endpoints return JSON (except `/api/export`, which returns a CSV or Excel file). All mutating endpoints accept/return `Content-Type: application/json`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/engineers` | List all engineers, including call/contact fields and a live-computed `needs_followup` |
| `POST` | `/api/engineers` | Create an engineer — body: `{ iekNumber, name, phone }` |
| `PUT` | `/api/engineers/:id` | Update name/phone, or cast a vote — body: any of `{ name, phone, voted }`. `voted: false` is rejected with 403 once `voted` is already `true` (see [Votes cannot be undone](#votes-cannot-be-undone)). Contact status is **not** settable here — use `/api/contact-calls`. |
| `DELETE` | `/api/engineers/:id` | Delete an engineer |
| `GET` | `/api/stats` | `{ total, voted, notVoted, turnout, needsFollowUp, notContacted }` |
| `POST` | `/api/reset-votes` | Set every engineer's `voted` back to `false` (history is preserved) |
| `GET` | `/api/export?type=X&format=Y` | Download a report — `type` is `engineers` (default), `stats`, `candidates`, `calls`, or `remarks`; `format` is `csv` (default) or `excel` |
| `POST` | `/api/import` | Bulk-add engineers from CSV text — body: `{ csv: "..." }` |
| `GET` | `/api/sms?engineerId=X` | SMS history — one engineer's, or the most recent 200 overall if omitted |
| `POST` | `/api/sms` | Send ONE personalized SMS — body: `{ engineerId, message, sentBy }` — see [SMS Draft Center](#6-sms-draft-center-optional) |
| `GET`/`POST`/`DELETE` | `/api/sms?kind=drafts[&id=X]` | List / save / delete saved message drafts |
| `GET` | `/api/sms?kind=replies` | Most recent 100 inbound SMS replies |
| `GET` | `/api/sms?kind=balance` | Always returns `{ balance: null }` — Sozuri has no API for this, check their dashboard |
| `POST` | `/api/sms-reply` | Inbound 2-way SMS webhook — point Sozuri's callback setting here, not called by the browser |
| `POST` | `/api/sms-status` | Delivery-status webhook (rewrites to `/api/sms-reply?kind=status`) — likewise Sozuri-only |
| `GET` | `/api/election-status` | `{ phase, startsAt, endsAt, serverTime, testMode }` — `phase` is `before` \| `live` \| `closed` |
| `GET` | `/api/audit-log` | Most recent 200 audit trail entries (read-only) |
| `GET` | `/api/candidates` | List all candidates (grouped by position, sorted by votes) |
| `POST` | `/api/candidates` | Add a candidate — body: `{ name, position, photoUrl? }` |
| `POST` | `/api/candidates/:id/vote` | Record one counted ballot for a candidate (+1) |
| `DELETE` | `/api/candidates/:id` | Remove a candidate (correction) |
| `GET` | `/api/contact-calls?engineerId=X` | Call history for one engineer (all calls if `engineerId` omitted, capped at 500) |
| `POST` | `/api/contact-calls` | Log a call — body: `{ engineerId, callerName, callStatus, notes? }`. This is the **only** way `contact_status` changes; it also increments `call_count` and stamps `last_contacted_at`. |
| `GET` | `/api/remarks?engineerId=X` | Authored remark history for one engineer |
| `POST` | `/api/remarks` | Add a remark — body: `{ engineerId, author, remark }` |
| `GET` | `/api/urgent` | Engineers flagged for follow-up, computed live (not from a stale stored column) |
| `GET` | `/api/analytics` | Status distribution, daily call activity, daily confirmations, turnout — powers the Analytics section |

### Candidates & Results — a separate concept from turnout

The `engineers` table tracks **turnout**: did a registered member show up and vote (yes/no). The new `candidates` table tracks **who people are voting for**, per office — e.g. "Eng. Stariko Nyamori, Honorary Treasurer." These are intentionally independent:

- Marking an engineer "Voted" in the turnout table does **not** change any candidate's tally.
- Recording a candidate's **+1 Vote** does **not** mark any engineer as having voted.
- A candidate does not need to also exist as a row in `engineers`, and vice versa.

This mirrors a real in-person process: a check-in desk marks who showed up (turnout), while ballots are counted separately into a tally per candidate. The **+1 Vote** button on a candidate card is how an official records each counted ballot.

**To add Eng. Stariko Nyamori (Honorary Treasurer):** open the app, click **+ Add Candidate**, and enter:
- Name: `Eng. Stariko Nyamori`
- Position: `Honorary Treasurer`
- Photo URL: `/images/stariko-nyamori.jpg` (already in the repo, cropped from the campaign poster you shared)

I didn't add him for you directly against your live production database — that's a real write to a live election system, and it's the kind of action you should trigger yourself rather than have it happen silently on your behalf. It takes 10 seconds once deployed.

If it turns out you actually need each individual engineer's vote to be attributed to a specific candidate (a real ballot — "this voter chose that candidate"), that's a further step up from what's here (linking `votes` to `candidates`, one selection per position per voter) and is a bigger change than what's been built in this pass — say so if that's what election day actually requires and it can be scoped properly rather than rushed in now.

### Candidate photos

`candidates.photo_url` is an optional field. Point it at any public image URL, or use a file already in this repo's `images/` folder (e.g. `/images/stariko-nyamori.jpg`, `/images/iek-logo.jpg` — both added from the WhatsApp images you shared, cropped to remove the WhatsApp UI chrome around the raw logo screenshot and to frame just the portrait from the campaign poster). A candidate without a photo falls back to an initials avatar, same as the engineers table.

### Canvassing / call tracking (full system)

Separate from turnout and from candidate tallies: this is your GOTV calling operation — call people, log what happened, see who still needs a call, before Monday.

**Contact status values** (set via the dropdown in the turnout table, the "📞 Call" button, or the Log Call modal — all three go through the same `POST /api/contact-calls` endpoint, so history is always complete regardless of which one you used):

| Status | Meaning |
|---|---|
| `pending` 📝 | Default — no call logged yet |
| `confirmed` ✅ | Called, they confirmed they'll vote |
| `no_answer` 📞 | Called, no answer |
| `busy_declined` 📱 | Called, was busy or declined |
| `follow_up` 🔄 | Called, unclear — needs a follow-up call |
| `not_reachable` ❌ | Number is wrong or off |

Every logged call writes a row to `contact_calls` (caller name, status, notes, timestamp) and bumps the engineer's `call_count` + `last_contacted_at`. **📞 Never Picked Up** is a one-click shortcut that logs `no_answer` with no modal. **👁 Details** opens a combined chronological history for that engineer — votes, calls, and remarks together, matching the Date/Time · Action · Person · Notes shape you asked for.

**Remarks with author:** `POST /api/remarks` records `{ author, remark, created_at }` as its own row — not an overwritten single field. Every remark shows who wrote it and when, e.g. "📝 Eng. James Ochieng — Called at 10:30 AM — Confirmed will vote." The old single `engineers.remarks` text column still exists (kept for backward-compat display as "Legacy imported note" in the Details modal), but the app writes new entries into the `remarks` table now, not that column — including **Import CSV**: any `remarks` text in an imported row gets an author `"CSV Import"` entry in `remarks` too (not just the legacy column), so it correctly counts toward the "no remark in 2 days" follow-up check instead of silently making a freshly-imported person look un-contacted.

**Who is "the caller"?** There's no login system here (see [Security note](#security-note-please-read)) — the app asks once per browser for **your name** (top-right badge, click to change) and stores it in that browser's `localStorage`. It stamps every call/remark you make from that device. **This is self-reported, not verified** — anyone can type any name. It's good enough for a small trusted team coordinating a GOTV effort; it is not an accountability system that would hold up if someone wanted to misattribute their own actions.

**🚨 Urgent (flagged for follow-up):** computed **live** on every request, not from a stored flag — one of the criteria ("no remark in 2 days") is time-based and would silently go stale if only checked when a row is written. Flagged when not yet voted, not confirmed, and any of: 3+ calls logged, current status is Follow-up/No Answer/Not Reachable, or no remark in the last 2 days.

**📅 Today's Agenda:** the not-yet-confirmed, not-yet-voted engineers, sorted oldest-contact-first (never-contacted people appear at the top) — computed client-side from the same data already on the page, so it's always in sync with what you're looking at.

**📊 Analytics:** call status distribution (pie), daily call volume and daily confirmations for the last 7 days (bar/line) — all hand-rolled inline SVG, deliberately **not** a third-party charting library. Two days before a real election is not when to introduce a new CDN dependency that could fail to load or break silently; plain SVG has zero external moving parts.

**Bulk actions:** check rows in the turnout table (or "select all" in the header) to reveal a bulk bar — apply one status to everyone selected, export just that selection to CSV, or print a call list (opens a separate print-formatted window, doesn't disturb the main page).

**Export formats:** the **Export** dropdown has a CSV/Excel toggle at the top — pick one, then choose a report (voter list, stats, candidates, call history, remarks). Excel isn't a real `.xlsx` (that's a zip container and genuinely needs a library to build correctly); it's a hand-rolled "Excel 2003 XML Spreadsheet" file, which Excel/LibreOffice/Google Sheets have all opened natively for 20+ years. Adding `xlsx`/`exceljs` as a dependency two days before a real election for one export button wasn't worth the risk.

**Full Report (PDF):** also in the Export dropdown — generates a standalone print-ready page (turnout summary, call status breakdown, candidate results, full voter list) and opens your browser's print dialog; choose **Save as PDF** as the destination. This is deliberately *not* a server-side PDF library (`pdfkit`, or worse, `puppeteer`) — browser-native print-to-PDF needs zero new dependencies and cannot fail the way a PDF-generation library on a serverless function under time pressure could.

### Bulk CSV import

Use the **Import CSV** button (next to Refresh) to add many engineers in one go instead of one at a time through the form. Expected columns, in order:

```
iek_number,name,phone,remarks
IEK009,Eng. Jane Doe,0700000000,Optional note
IEK010,Eng. John Smith,0700000001,
```

- A header row is optional — if the first cell is `iek_number` (or similar), it's auto-skipped.
- `remarks` is optional; the other three columns are required per row.
- Existing IEK numbers are **skipped, never overwritten** — edit those individually via the table's Edit button instead.
- Rows missing a required field are skipped and reported back in the toast/response, not silently dropped.
- **Only `.csv` is supported**, not raw `.xlsx`. If your list is in Excel, use *File → Save As → CSV* first — adding real `.xlsx` binary parsing would mean a new dependency (e.g. `xlsx`/`exceljs`) that nothing else in this project needs; say so if you actually want that added.

Setting `voted: true` via `PUT /api/engineers/:id` inserts a row into `votes` (with `voter_ip`) and logs `VOTE` to `audit_log`. Any other field change logs `UPDATE`. Create/delete log `CREATE`/`DELETE`. Resetting logs a single `RESET_ALL`. (There is no more `UNDO_VOTE` — see below.)

---

## Election window & voting lock

The voting window is hardcoded in `api/_config.js`:

```js
export const VOTING_START = new Date("2026-08-03T06:00:00+03:00"); // Mon Aug 3 2026, 6:00 AM EAT
export const VOTING_END   = new Date("2026-08-03T17:00:00+03:00"); // Mon Aug 3 2026, 5:00 PM EAT
```

This is enforced **server-side**, not just in the UI — `PUT /api/engineers/:id` rejects any attempt to cast a *new* vote (`{ voted: true }` on someone who hasn't voted yet) with `403` outside this window, regardless of what the browser shows. The frontend countdown banner reflects the same window via `GET /api/election-status`, re-checked every 5 seconds so it self-corrects if a client's clock is off.

Editing details, logging calls/remarks, adding/importing engineers, exporting, and viewing the audit log are **not** time-gated — those are setup/admin actions you'll need before and after the window, not "casting a ballot."

### Votes cannot be undone

Once `voted` is `true` for an engineer, `PUT /api/engineers/:id` with `{ voted: false }` is rejected with `403` — there is no "Undo" button in the UI anymore. This was a deliberate, explicit request ("election integrity"), and it's worth being clear about the actual tradeoff: **a misclick during real voting is now permanent through the app.** There is no in-app correction path.

If a genuine mistake happens on election day (wrong row clicked), the only fix is a direct database correction — in the Neon Console SQL Editor:

```sql
-- Find the engineer and their vote row first to confirm you have the right one:
SELECT e.id, e.iek_number, e.name, e.voted, v.id AS vote_id, v.voted_at
FROM engineers e JOIN votes v ON v.engineer_id = e.id
WHERE e.iek_number = 'IEK00X';

-- Then, deliberately, as a rare emergency correction:
DELETE FROM votes WHERE id = <vote_id_from_above>;
UPDATE engineers SET voted = FALSE WHERE id = <engineer_id_from_above>;
```
This bypasses the app entirely on purpose — it's an emergency hatch, not a workflow, and won't appear in `audit_log` (since it never goes through the API). If you'd rather have a proper in-app correction path with its own audit trail (e.g. requiring a second confirmation, logged distinctly from a normal vote), that's a reasonable thing to add — just flagging that "cannot be unvoted" and "zero correction path" are two different asks, and only the first was requested here.

`POST /api/reset-votes` (the **Reset All Votes** button) is unaffected by this — it's a deliberate bulk/admin action for clearing *test* votes before the real window opens, not a per-row undo. Don't use it after real voting has started.

**To change the date/time:** edit the two constants in `api/_config.js` and redeploy.

### Testing the vote flow before Monday

With the real dates in place, every "Mark Voted" click will be rejected with *"Voting has not started yet"* until 6:00 AM Monday — including your own testing today. To test the full voting flow right now:

1. In Vercel → Settings → Environment Variables, add `ALLOW_TEST_VOTES` = `true`.
2. Redeploy. The countdown banner will show a "⚠️ TEST MODE" notice and every vote will be accepted regardless of the clock.
3. **Before election day, delete that variable (or set it to `false`) and redeploy again** — otherwise the real time-lock never actually takes effect and anyone can vote at any time.

## Real-time updates

Every open device polls `GET /api/engineers` + `GET /api/stats` every 5 seconds and diffs the result against what it last saw, to:
- Update the dashboard, table, and turnout bar without a manual refresh.
- Fire a toast + notification-bell entry when someone votes or a new engineer is registered.

**Why polling instead of WebSockets:** the ask allowed either ("setInterval() ... OR implement WebSocket"). A 5-second poll of two small JSON endpoints is simple, needs no persistent-connection infrastructure, and is plenty responsive for an in-person election-day check-in desk. The **Refresh** button and the **🔔 Live** badge remain as an always-available manual/visual backup. If you later need sub-second updates across many simultaneous remote voters, that's the point where WebSockets (Vercel Functions do support them) would start to earn their added complexity.

## How to Use the App

1. **Set your name** — click the badge top-right, once per browser. Stamps every call/remark you log (self-reported, not verified — see [call tracking](#canvassing--call-tracking-full-system)).
2. **Dashboard** — Total Registered, Voted, Not Voted, Turnout %, Needs Follow-up update from the database on every load and after every action.
3. **Register an engineer** — **➕ Add Engineer** → fill IEK Number, Name, Phone.
4. **Search / filter** — search box filters by name/IEK number/phone; **All / Voted / Not Voted** buttons and the contact-status dropdown filter the table. Both operate on the last data fetched from the server.
5. **Mark a vote** — **VOTE** → confirm. **This cannot be undone** through the app (see [Votes cannot be undone](#votes-cannot-be-undone)).
6. **Log a call** — **📞 Call** opens the Log Call modal (pick a status, optional notes); **📞 Never Picked Up** is a one-click shortcut; the inline dropdown in the Contact column does the same thing without notes.
7. **View full history** — **👁 Details** shows a combined timeline of votes/calls/remarks for that engineer, plus quick Log Call / Add Remark buttons.
8. **Edit / Remove** — update an engineer's name/phone, or delete their record.
9. **Bulk actions** — check rows (or "select all"), then apply a status to everyone selected, export just that selection, or print a call list.
10. **🚨 Urgent / 📅 Today's Agenda / 📊 Analytics** — jump to these via the nav pills under the header.
11. **Refresh** — re-fetches the latest data from the database (useful if someone else just acted from another device).
12. **Import CSV** — bulk-add many engineers at once from a `.csv` file (see [Bulk CSV import](#bulk-csv-import) below).
13. **Export** — pick CSV or Excel, then a report type (voter list, stats, candidates, call history, remarks); or choose **Full Report** to open a print-ready page you can Save as PDF.
14. **Print** — clean, controls-free printout of the main page.
15. **Reset All Votes** — clears the live "voted" flag for everyone; historical `votes`/`audit_log` rows are kept. Only use this before the real window opens (see the tradeoff note above).

If the API can't reach the database, a red banner appears at the top with a **Retry** button instead of the page silently showing stale or empty data.

---

## Security note (please read)

This build intentionally does **not** include authentication — it wasn't part of the request, and bolting one on unasked would have meant inventing a login flow, session storage, and UI for it. But said plainly: **as shipped, every mutating endpoint** (`POST`/`PUT`/`DELETE` on engineers, candidates, contact-calls, remarks, reset-votes, import, **and now SMS**) **is open to anyone who can reach your deployment URL**, via `curl` or otherwise — not just through the app's buttons.

**`POST /api/sms` deserves its own callout, worse than the others:** the other endpoints cost you nothing to abuse and are fixable by editing a database row. SMS costs real money per message and, once sent, **cannot be un-sent** — someone finding your URL could send arbitrary text, at your expense, to all 210 real people's phones, and there's no undo. If this app's URL is anything less than fully private, this is the endpoint I'd protect first, even with something quick (see options below) rather than none at all. `POST /api/sms-reply` is lower risk (it's a webhook, not a page action, and worst case someone forges a fake reply), but it can still write `contact_status = 'confirmed'` for an engineer without a real call happening, so don't treat it as exempt from the same protection.

For a real election with real voters, you should add one of:

- Basic auth or an admin token check in front of the mutating endpoints (quick, but limited).
- A real auth provider (see Vercel's Marketplace auth integrations — Clerk, Auth0, etc.) gating who can reach the admin UI at all.
- Network-level restriction (e.g., only expose write access on a private/VPN-only deployment for election-day officials, read-only elsewhere).

Ask if you want this wired in — it's a meaningfully different scope than what was built here (frontend + database + CRUD API), so it wasn't added silently.

A few more specifics for election day:
- `GET /api/audit-log` is read-only but exposes voter IP addresses to anyone who can reach it — acceptable for an internal committee tool, worth knowing if the link is ever shared outside the committee.
- The voting-window lock (`403` outside the Monday window) blocks *casting a new vote* server-side, but does **not** stop someone from adding/editing/deleting engineer records, or logging calls/remarks, at any time — intentional (you need to keep working right up to Monday), but means the same lack of authentication applies to those endpoints around the clock.
- **The "caller name" on calls and remarks is self-typed, not authenticated.** Anyone with the link can log a call as anyone else's name. Fine for a small trusted team; not an accountability system that would survive someone deliberately misattributing their actions.
- **Votes cannot be reversed through the app once cast** (see [above](#votes-cannot-be-undone)) — combined with no authentication, this means a wrong click during real voting has no in-app recourse at all, only a manual database correction. Weigh whether that tradeoff is acceptable for your event, given there's no login to prevent the wrong click from a stranger in the first place.

---

## Deployment scripts

`DEPLOY.bat` / `deploy.ps1` (unchanged in behavior from before) stage, commit, and push to GitHub, which triggers Vercel's Git integration to redeploy. They do **not** touch your database or run migrations — `node setup.js` does that. After pushing, the script reminds you to confirm `DATABASE_URL` is set in Vercel.

---

## Election Day Checklist

**Before Monday:**
- [ ] Run `node setup.js` (or `node fix-database.js`) at least once after this upgrade — it migrates existing live data: remaps old `contact_status` values to the new vocabulary, adds the new columns/tables, and backfills legacy remarks. Safe to re-run.
- [ ] Confirm `ALLOW_TEST_VOTES` is **not** set to `true` in Vercel (Settings → Environment Variables). If you added it to test, remove it or set it to `false`, then redeploy.
- [ ] Register every eligible engineer (via the form, **Import CSV**, or `POST /api/import`).
- [ ] Add every candidate (e.g. Eng. Stariko Nyamori — Honorary Treasurer) via **+ Add Candidate** in the Candidates & Results section.
- [ ] Double-check `api/_config.js` has the correct start/end date/time if it ever needs to change — it now unlocks at **6:00 AM** Monday, matching the official IEK election notice.
- [ ] Run **Reset All Votes** once, right before the real window opens, if anyone cast test votes while `ALLOW_TEST_VOTES` was on — otherwise their test vote will still show as "Voted" on the real day, and **it can no longer be undone per-row** once real voting starts.
- [ ] Set your name via the identity badge before logging any calls, so history is attributed correctly.
- [ ] Start working through **📅 Today's Agenda** / **🚨 Urgent** to reach everyone before Monday.
- [ ] Share the live link: `https://iek-voting-system.vercel.app` (or check your Vercel dashboard for your actual assigned domain if this one isn't it).
- [ ] Read the [Security note](#security-note-please-read) — there is currently no login, so anyone with the link can vote, add, or edit, and votes can't be corrected in-app once cast. Fine for a supervised in-person check-in desk; not fine if the link goes somewhere uncontrolled.

**On election day:**
- [ ] The countdown banner flips to "🟢 VOTING IS LIVE!" automatically at **6:00 AM** — no action needed.
- [ ] Vote buttons enable automatically at the same moment across every open device/tab.
- [ ] Use **View Audit Log** any time to see a live who/what/when trail of every action.
- [ ] At 5:00 PM the banner flips to "🔴 VOTING CLOSED" and vote buttons disable automatically — again, no action needed.

**After voting closes:**
- [ ] **Export** — pull the Full Voter List, Turnout Statistics, Candidate Results, and Call History reports (CSV or Excel) for the official record, and generate a **Full Report PDF** (Export dropdown → Save as PDF) as a single-document snapshot.
- [ ] **View Audit Log** to review the full trail if anything needs reconciling.
- [ ] Consider taking the deployment offline or restricting write access afterward, since the API has no login and will otherwise stay open indefinitely.

## Browser Support

Latest Chrome, Firefox, Edge, and Safari (desktop and mobile). Requires JavaScript.

---

## License

MIT License — free to use and adapt for IEK branch and council elections.
