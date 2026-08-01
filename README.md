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
├── api/
│   ├── _db.js                # Shared Neon connection (lazy-initialized)
│   ├── _utils.js              # CORS, audit logging, IP extraction, error helper
│   ├── engineers.js           # GET (list) / POST (create)
│   ├── engineers/
│   │   └── [id].js              # PUT (update/vote) / DELETE
│   ├── stats.js               # GET — total/voted/notVoted/turnout
│   ├── reset-votes.js         # POST — reset all engineers to "not voted"
│   ├── export.js              # GET — CSV download
│   ├── seed.js                # POST — insert the 8 sample engineers
│   └── import.js              # POST — bulk-add engineers from CSV text
├── setup.js                  # One-command bootstrap: tables + seed + git push + deploy
├── .env.example             # Template for required env vars (committed)
├── .env.local                # Your real local DATABASE_URL (gitignored)
├── package.json
├── vercel.json
├── .gitignore
├── DEPLOY.bat / deploy.ps1   # One-click git add/commit/push
└── README.md
```

---

## Quickest path: `node setup.js`

If `.env.local` already has your real Neon `DATABASE_URL` in it, one command does steps 3–8 below in order: installs dependencies, connects to Neon, creates tables, seeds the 8 sample engineers, verifies `package.json`/`vercel.json`, then commits and pushes to GitHub (which triggers Vercel's auto-deploy), with a best-effort `vercel --prod` if the Vercel CLI is installed and logged in.

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
3. Optionally add `SEED_SECRET` (any random string) to lock down `POST /api/seed` — see [Security note](#security-note-please-read).
4. Redeploy (or push a commit) after adding env vars — Vercel Functions only pick up new env vars on a fresh deployment.

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

## 4. Seed the sample data

Once your schema is created and `DATABASE_URL` is set, seed the 8 sample engineers:

```bash
# Local (vercel dev running on port 3000)
curl -X POST http://localhost:3000/api/seed

# Production
curl -X POST https://your-project.vercel.app/api/seed
```

If you set `SEED_SECRET`, include it:
```bash
curl -X POST https://your-project.vercel.app/api/seed -H "x-seed-key: your-secret-here"
```

Seeding is idempotent — engineers with an already-existing IEK number are skipped, so it's safe to call more than once.

| IEK Number | Name | Phone |
|---|---|---|
| IEK001 | Eng. James Ochieng | 0712345678 |
| IEK002 | Eng. Mary Wanjiru | 0723456789 |
| IEK003 | Eng. Peter Mwangi | 0734567890 |
| IEK004 | Eng. Sarah Akinyi | 0745678901 |
| IEK005 | Eng. David Odhiambo | 0756789012 |
| IEK006 | Eng. Grace Njeri | 0767890123 |
| IEK007 | Eng. Michael Otieno | 0778901234 |
| IEK008 | Eng. Faith Wambui | 0789012345 |

---

## 5. Deploy to Vercel

```bash
vercel --prod
```

or push to GitHub (Vercel's Git integration auto-deploys), or double-click `DEPLOY.bat` if this repo is already linked to GitHub + Vercel — see [Deployment scripts](#deployment-scripts) below.

Vercel auto-detects the `/api` folder as Functions; no build step is required for the static frontend (`outputDirectory` is set to `.` in `vercel.json`).

---

## API Reference

All endpoints return JSON (except `/api/export`, which returns a CSV file). All mutating endpoints accept/return `Content-Type: application/json`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/engineers` | List all engineers |
| `POST` | `/api/engineers` | Create an engineer — body: `{ iekNumber, name, phone, remarks? }` |
| `PUT` | `/api/engineers/:id` | Update an engineer — body: any of `{ name, phone, remarks, voted }` |
| `DELETE` | `/api/engineers/:id` | Delete an engineer |
| `GET` | `/api/stats` | `{ total, voted, notVoted, turnout }` |
| `POST` | `/api/reset-votes` | Set every engineer's `voted` back to `false` (history is preserved) |
| `GET` | `/api/export` | Download all engineers as CSV |
| `POST` | `/api/seed` | Insert the 8 sample engineers (idempotent, optionally protected by `SEED_SECRET`) |
| `POST` | `/api/import` | Bulk-add engineers from CSV text — body: `{ csv: "..." }` |

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

Setting `voted: true` via `PUT /api/engineers/:id` inserts a row into `votes` (with `voter_ip`) and logs `VOTE` to `audit_log`. Setting it back to `false` logs `UNDO_VOTE`. Any other field change logs `UPDATE`. Create/delete log `CREATE`/`DELETE`. Resetting logs a single `RESET_ALL`.

---

## How to Use the App

1. **Dashboard** — Total Registered, Voted, Not Voted, Turnout % update from the database on every load and after every action.
2. **Register an engineer** — **➕ Add Engineer** → fill IEK Number, Name, Phone, optional Remarks.
3. **Search / filter** — search box filters by name/IEK number/phone; **All / Voted / Not Voted** buttons filter by status. Both operate on the last data fetched from the server.
4. **Mark a vote** — **Mark Voted** → confirm. **Undo** reverts it.
5. **Remarks** — click **Remarks** to attach/edit a note.
6. **Edit / Remove** — update or delete an engineer's record.
7. **Refresh** — re-fetches the latest data from the database (useful if someone else just voted from another device).
8. **Import CSV** — bulk-add many engineers at once from a `.csv` file (see [Bulk CSV import](#bulk-csv-import) below).
9. **Export CSV** — downloads the live register via `/api/export`.
10. **Print** — clean, controls-free printout.
11. **Reset All Votes** — clears the live "voted" flag for everyone; historical `votes`/`audit_log` rows are kept.

If the API can't reach the database, a red banner appears at the top with a **Retry** button instead of the page silently showing stale or empty data.

---

## Security note (please read)

This build intentionally does **not** include authentication — it wasn't part of the request, and bolting one on unasked would have meant inventing a login flow, session storage, and UI for it. But said plainly: **as shipped, `POST /api/engineers`, `PUT /api/engineers/:id`, `DELETE /api/engineers/:id`, `POST /api/reset-votes`, and `POST /api/import` are open to anyone who can reach your deployment URL**, via `curl` or otherwise — not just through the app's buttons. For a real election with real voters, you should add one of:

- Basic auth or an admin token check in front of the mutating endpoints (quick, but limited).
- A real auth provider (see Vercel's Marketplace auth integrations — Clerk, Auth0, etc.) gating who can reach the admin UI at all.
- Network-level restriction (e.g., only expose write access on a private/VPN-only deployment for election-day officials, read-only elsewhere).

Ask if you want this wired in — it's a meaningfully different scope than what was built here (frontend + database + CRUD API), so it wasn't added silently.

---

## Deployment scripts

`DEPLOY.bat` / `deploy.ps1` (unchanged in behavior from before) stage, commit, and push to GitHub, which triggers Vercel's Git integration to redeploy. They do **not** touch your database, run migrations, or seed data — do those manually per the steps above. After pushing, the script reminds you to confirm `DATABASE_URL` is set in Vercel and to seed a fresh database if needed.

---

## Browser Support

Latest Chrome, Firefox, Edge, and Safari (desktop and mobile). Requires JavaScript.

---

## License

MIT License — free to use and adapt for IEK branch and council elections.
