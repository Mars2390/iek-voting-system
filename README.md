# IEK Online Voting System

A professional, single-page web application for tracking voter turnout at Institution of Engineers of Kenya (IEK) elections — engineer registration, marking votes cast, live turnout statistics, search/filtering, CSV export, and print-ready reports, themed in the colors of the Kenyan flag.

![Status](https://img.shields.io/badge/status-active-brightgreen) ![Deploy](https://img.shields.io/badge/deploy-Vercel-black) ![License](https://img.shields.io/badge/license-MIT-black)

---

## Description

The IEK Online Voting System is a lightweight, single-page application (SPA) built with plain HTML, CSS, and JavaScript — no framework, no build step, no server required. It lets election officials register engineers, mark them as **Voted** or **Not Voted** as they check in, attach remarks per record, and monitor live turnout through a statistics dashboard and filterable table.

All data is stored locally in the browser via `localStorage`, so the app works **fully offline** (no internet connection needed once loaded) and **fully online** when deployed to Vercel or any static host — the same files run either way with zero configuration changes.

> **Note on election integrity:** Because this version stores data in the browser's `localStorage`, each device/browser keeps its own independent register. It is best suited for a single supervised voting station (e.g. one check-in desk at a branch AGM), demos, or as a front-end reference to wire up to a real shared backend. See [Scaling to Production](#scaling-to-production) below for running this across multiple devices with one shared, tamper-resistant register.

---

## Features

- 🇰🇪 **Kenyan-themed UI** — black, red, green and white color scheme with an animated flag strip
- 📊 **Live statistics dashboard** — Total Registered, Voted, Not Voted, and Turnout % with an animated turnout bar
- 📋 **Engineers table** — IEK Number, Name, Phone, Status, and Remarks columns
- ➕ **Add Engineer form** — register with IEK Number, Full Name, Phone, and optional Remarks
- ✏️ **Edit & remove** — update any engineer's details or remove them from the register
- 🔍 **Search bar** — instantly filter by name, IEK number, or phone
- 🧰 **Filter buttons** — one-click toggle between All / Voted / Not Voted
- 🗳️ **Mark as Voted** — confirmation-protected vote button with an **Undo** option for corrections
- 📝 **Remarks** — attach or edit a note against any engineer (e.g. "Voted by proxy", "ID verified")
- 💾 **Persistent storage** — all data is saved to `localStorage` and survives refreshes and offline use
- 📤 **CSV export** — download the full register (including status and remarks) as a spreadsheet
- 🖨️ **Print-friendly report** — dedicated print stylesheet hides controls/forms for a clean printout
- ♻️ **Reset all votes** — zero out every status back to "Not Voted" to start a fresh round
- 📱 **Fully responsive** — works on desktop, tablet, and mobile
- ▲ **Vercel-ready** — includes `vercel.json` and `package.json` for one-command deployment

---

## Sample Data

The app ships pre-seeded with 8 sample engineers (all starting as "Not Voted") so the table is populated on first load:

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

Remove or edit these at any time from the table.

---

## Project Structure

```
IEK-VOTING-FULL/
├── index.html      # Main HTML structure (dashboard, form, table)
├── styles.css      # All styling (Kenyan theme, responsive layout, animations)
├── script.js       # All application logic (CRUD, status, search, export, print)
├── vercel.json     # Vercel deployment configuration
├── package.json    # Project metadata & scripts for Vercel/local dev
├── .gitignore      # Files excluded from version control
└── README.md       # Project documentation
```

---

## Installation Guide

No build tools or package installation are required to run the app — it's static HTML/CSS/JS.

### Option 1 — Open directly (offline)
1. Download or clone this folder.
2. Double-click `index.html` to open it in your browser.

### Option 2 — Run a local dev server
```bash
npm install -g vercel   # optional, only needed for Vercel CLI features
npm run dev             # serves the app at http://localhost:3000
```

### Option 3 — Deploy to Vercel (online)

**Via CLI:**
```bash
npm i -g vercel
vercel login
vercel            # deploy a preview
vercel --prod     # deploy to production
```

**Via Git integration:**
1. Push this folder to a GitHub/GitLab/Bitbucket repository.
2. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
3. Vercel auto-detects it as a static site (no framework, no build command needed) — click **Deploy**.
4. Your voting system will be live at `https://<your-project>.vercel.app`.

Because everything runs client-side with `localStorage`, the deployed site works identically whether the visitor is online or has gone offline after the first page load.

---

## How to Use

1. **View the dashboard** — see Total Registered, Voted, Not Voted, and Turnout % update live as votes are marked.
2. **Register an engineer** — click **➕ Add Engineer**, fill in IEK Number, Full Name, Phone (and optional Remarks), then submit.
3. **Search** — type a name, IEK number, or phone into the search bar to instantly filter the table.
4. **Filter by status** — use the **All / Voted / Not Voted** buttons to narrow the table.
5. **Mark a vote** — click **Mark Voted** next to an engineer; confirm the prompt. Use **Undo** to revert a mistaken entry.
6. **Add remarks** — click **Remarks** on any row to attach or edit a note (e.g. verification notes).
7. **Edit a record** — click **Edit** to update an engineer's IEK number, name, phone, or remarks.
8. **Remove a record** — click **Remove** to delete an engineer from the register (with confirmation).
9. **Export results** — click **Export CSV** to download the full register as a spreadsheet.
10. **Print a report** — click **Print** for a clean, controls-free printout.
11. **Start a new round** — click **Reset All Votes** to set every engineer back to "Not Voted".

---

## Scaling to Production

To run this system across **multiple devices sharing one live register** (recommended for a real, large-scale election), extend it with:

- A backend API (Node/Express, Vercel Functions, etc.) backed by a real database (e.g. Postgres/Redis via the Vercel Marketplace) instead of `localStorage`
- Voter/staff authentication so only authorized officials can mark votes or edit records
- An audit log of every status change (timestamp, IEK number, official who made the change)
- HTTPS (provided automatically by Vercel) and server-side validation for every request
- Real-time sync across devices (e.g. polling, WebSockets, or Server-Sent Events) so all check-in stations see the same live turnout

The existing `index.html` / `styles.css` / `script.js` can stay largely the same on the front end — `script.js`'s `save()`, `load()`, `markVoted()`, and `undoVote()` functions are the natural integration points to swap `localStorage` calls for `fetch()` calls to a real API.

---

## Browser Support

Latest versions of Chrome, Firefox, Edge, and Safari (desktop and mobile). Requires JavaScript and `localStorage` to be enabled.

---

## License

MIT License — free to use and adapt for IEK branch and council elections.
