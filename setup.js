#!/usr/bin/env node
// =========================================================
// IEK Voting System — one-command project bootstrap
//
//   node setup.js
//
// Installs dependencies, connects to Neon, creates tables,
// seeds sample engineers, verifies config files, commits +
// pushes to GitHub, and (if the Vercel CLI is available)
// triggers a production deploy.
//
// SECURITY: this file contains NO database credentials. It
// reads DATABASE_URL from .env.local at runtime — which is
// git-ignored — instead of hardcoding it here. Do not paste
// your connection string into this file: this script commits
// and pushes itself to GitHub, and anything hardcoded here
// would be pushed right along with it.
// =========================================================

import { existsSync, readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

function step(msg) { console.log(`\n➡️  ${msg}`); }
function ok(msg) { console.log(`✅ ${msg}`); }
function warn(msg) { console.log(`⚠️  ${msg}`); }
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function run(cmd, { allowFail = false, silent = false } = {}) {
  try {
    return execSync(cmd, { stdio: silent ? "pipe" : "inherit", encoding: "utf8" });
  } catch (err) {
    if (allowFail) return "";
    fail(`Command failed: ${cmd}\n${err.message}`);
    return "";
  }
}

function commandExists(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [cmd], { stdio: "ignore" });
  return result.status === 0;
}

function isSecretEnvFile(filename) {
  const base = path.basename(filename.trim());
  if (base === ".env" || base === ".env.local") return true;
  if (/^\.env\..+\.local$/.test(base)) return true;
  return false;
}

// ---------------------------------------------------------
// 0. Load DATABASE_URL (and friends) from .env.local
// ---------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  if (!existsSync(envPath)) {
    fail(
      ".env.local not found. Copy .env.example to .env.local, fill in your real " +
      "Neon DATABASE_URL, then run `node setup.js` again."
    );
  }

  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("REPLACE_ME")) {
    fail("DATABASE_URL is missing or still a placeholder in .env.local. Fill it in and re-run.");
  }
}

function assertNoSecretsStaged() {
  const status = run("git status --porcelain", { allowFail: true, silent: true }) || "";
  const dangerous = status
    .split("\n")
    .filter((line) => line.length > 3)
    .filter((line) => isSecretEnvFile(line.slice(3)));

  if (dangerous.length > 0) {
    fail(
      "Refusing to commit: a real .env file is staged. This would leak your database " +
      "password to GitHub.\n" + dangerous.join("\n") +
      "\nRun `git reset <file>` to unstage it, confirm .gitignore covers it, and re-run this script."
    );
  }
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------
async function main() {
  console.log("=================================================");
  console.log("  IEK VOTING SYSTEM — ONE-COMMAND SETUP");
  console.log("=================================================");

  step("Loading DATABASE_URL from .env.local");
  loadEnvLocal();
  ok(".env.local verified (DATABASE_URL present)");

  step("Installing dependencies (npm install)");
  run("npm install --no-fund --no-audit");
  ok("Dependencies installed!");

  step("Connecting to Neon PostgreSQL");
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`SELECT 1`;
  } catch (err) {
    fail(`Could not connect to the database: ${err.message}`);
  }
  ok("Database connected!");

  step("Creating tables (if they don't already exist)");
  await sql`
    CREATE TABLE IF NOT EXISTS engineers (
      id SERIAL PRIMARY KEY,
      iek_number VARCHAR(20) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(20),
      voted BOOLEAN DEFAULT FALSE,
      remarks TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
      voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      voter_ip VARCHAR(50)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      action VARCHAR(50),
      engineer_id INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_ip VARCHAR(50)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_votes_engineer_id ON votes(engineer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_log_engineer_id ON audit_log(engineer_id)`;
  await sql`
    CREATE TABLE IF NOT EXISTS candidates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      position VARCHAR(100) NOT NULL,
      votes INTEGER DEFAULT 0,
      photo_url TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position)`;

  // Sync columns added after the tables already existed on a live database.
  // ADD COLUMN IF NOT EXISTS is a no-op (and touches no existing rows) when
  // the column is already there.
  await sql`ALTER TABLE engineers ADD COLUMN IF NOT EXISTS contact_status VARCHAR(20) DEFAULT 'pending'`;
  await sql`ALTER TABLE engineers ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMP`;
  await sql`ALTER TABLE engineers ADD COLUMN IF NOT EXISTS call_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE engineers ADD COLUMN IF NOT EXISTS confirmed_vote BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE engineers ADD COLUMN IF NOT EXISTS needs_followup BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS photo_url TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS contact_calls (
      id SERIAL PRIMARY KEY,
      engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
      caller_name VARCHAR(100),
      call_status VARCHAR(50),
      notes TEXT,
      called_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS remarks (
      id SERIAL PRIMARY KEY,
      engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
      author VARCHAR(100),
      remark TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_contact_calls_engineer_id ON contact_calls(engineer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_contact_calls_called_at ON contact_calls(called_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_remarks_engineer_id ON remarks(engineer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_remarks_created_at ON remarks(created_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS sms_log (
      id SERIAL PRIMARY KEY,
      engineer_id INTEGER REFERENCES engineers(id) ON DELETE CASCADE,
      phone VARCHAR(20),
      message TEXT,
      status VARCHAR(20),
      provider_status VARCHAR(50),
      provider_message_id VARCHAR(120),
      sent_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sms_drafts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sms_replies (
      id SERIAL PRIMARY KEY,
      engineer_id INTEGER REFERENCES engineers(id) ON DELETE SET NULL,
      phone VARCHAR(20),
      message TEXT,
      matched_keyword VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_sms_log_engineer_id ON sms_log(engineer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sms_log_created_at ON sms_log(created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sms_replies_engineer_id ON sms_replies(engineer_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sms_replies_phone ON sms_replies(phone)`;

  ok("Tables created/synced! (existing engineers/votes/audit_log/candidates data is untouched)");

  step("Migrating contact_status values to the new vocabulary");
  // Earlier version of this app used: not_contacted, confirmed, follow_up, declined.
  // New vocabulary: pending, confirmed, no_answer, busy_declined, follow_up, not_reachable.
  // 'confirmed' and 'follow_up' are unchanged; remap the rest. Safe to re-run —
  // once migrated, these WHERE clauses match zero rows.
  const remapped1 = await sql`UPDATE engineers SET contact_status = 'pending' WHERE contact_status = 'not_contacted' RETURNING id`;
  const remapped2 = await sql`UPDATE engineers SET contact_status = 'busy_declined' WHERE contact_status = 'declined' RETURNING id`;
  const remapped3 = await sql`UPDATE engineers SET contact_status = 'pending' WHERE contact_status IS NULL RETURNING id`;
  const remappedTotal = remapped1.length + remapped2.length + remapped3.length;
  if (remappedTotal > 0) {
    ok(`Remapped ${remappedTotal} row(s) to the new contact_status vocabulary.`);
  } else {
    ok("No old-vocabulary contact_status values found (already migrated, or fresh database).");
  }

  step("Backfilling legacy remarks into the remarks table");
  // Only inserts a 'Legacy Import' row for engineers that don't already have
  // one — safe to re-run without creating duplicates on repeat setup.js runs.
  const backfilled = await sql`
    INSERT INTO remarks (engineer_id, author, remark)
    SELECT e.id, 'Legacy Import', e.remarks
    FROM engineers e
    WHERE e.remarks IS NOT NULL AND e.remarks <> ''
      AND NOT EXISTS (
        SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.author = 'Legacy Import'
      )
    RETURNING id
  `;
  ok(`${backfilled.length} legacy remark(s) migrated into the remarks table (existing entries untouched).`);

  step("Syncing confirmed_vote / needs_followup");
  await sql`UPDATE engineers SET confirmed_vote = (contact_status = 'confirmed')`;
  // needs_followup is refreshed live by the API on every read (see api/urgent.js
  // and api/engineers.js) since one of its conditions is time-based ("no remark
  // in 2 days") and would silently go stale if only computed here. This is just
  // a one-time backfill so the stored column isn't misleadingly blank.
  await sql`
    UPDATE engineers e SET needs_followup = (
      NOT e.voted AND e.contact_status <> 'confirmed' AND (
        e.call_count >= 3
        OR e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')
        OR NOT EXISTS (
          SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.created_at > NOW() - INTERVAL '2 days'
        )
      )
    )
  `;
  ok("confirmed_vote and needs_followup synced.");

  // NOTE: this used to auto-seed 8 fake demo engineers (IEK001-IEK008) here
  // on every run. Removed once the real ~210-voter register was imported —
  // re-running this on every deploy would have brought the demo rows back
  // right after they were deliberately deleted. If you ever need throwaway
  // test data again, add rows by hand through the UI instead.

  step("Verifying package.json / vercel.json");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (pkg.type !== "module" || !pkg.dependencies?.["@neondatabase/serverless"]) {
    fail('package.json is missing "type": "module" or the @neondatabase/serverless dependency.');
  }
  if (!existsSync("vercel.json")) fail("vercel.json is missing.");
  JSON.parse(readFileSync("vercel.json", "utf8")); // throws if malformed
  ok("package.json and vercel.json look correct.");

  step("Committing and pushing to GitHub");
  if (!commandExists("git")) fail("git is not installed or not on PATH.");

  const insideRepo = run("git rev-parse --is-inside-work-tree", { allowFail: true, silent: true });
  if (!insideRepo || !insideRepo.trim()) {
    fail("This folder is not a git repository. Run `git init` and connect a GitHub remote first.");
  }

  const branch = (run("git branch --show-current", { silent: true }) || "").trim();
  const remoteUrl = (run("git remote get-url origin", { allowFail: true, silent: true }) || "").trim();
  if (!remoteUrl) fail("No 'origin' remote configured. Add one with: git remote add origin <your-repo-url>");

  run("git add .");
  assertNoSecretsStaged();

  const statusPorcelain = (run("git status --porcelain", { silent: true }) || "").trim();
  if (!statusPorcelain) {
    ok("Nothing to commit — repo already up to date.");
  } else {
    run(`git commit -m "Automated setup: ${new Date().toISOString()}"`);

    try {
      execSync(`git pull --rebase --autostash origin ${branch}`, { stdio: "inherit" });
    } catch (err) {
      fail(
        "git pull --rebase failed — likely a merge conflict.\n" +
        "Your commit is safe locally but was NOT pushed. Resolve the conflict, run " +
        "`git rebase --continue`, then re-run node setup.js."
      );
    }

    try {
      execSync("git push", { stdio: "inherit" });
    } catch (err) {
      try {
        execSync(`git push --set-upstream origin ${branch}`, { stdio: "inherit" });
      } catch (err2) {
        fail("git push failed. Check your GitHub credentials/permissions above.");
      }
    }
    ok("Pushed to GitHub!");
  }

  step("Triggering Vercel deployment");
  if (commandExists("vercel")) {
    const deployResult = run("vercel --prod --yes", { allowFail: true });
    if (deployResult) {
      ok("Vercel CLI deployment ran — see the production URL printed above.");
    } else {
      warn("Vercel CLI deploy did not complete (are you logged in? run `vercel login`). " +
           "Your git push above will still trigger an automatic deployment via Vercel's GitHub integration.");
    }
  } else {
    ok("Vercel CLI not installed — skipping direct deploy. Your git push above will trigger " +
       "an automatic deployment via Vercel's existing GitHub integration instead.");
  }

  console.log("\n=================================================");
  console.log("🎉 SETUP COMPLETE");
  console.log("=================================================");
  console.log("Check your Vercel dashboard for the live deployment and its URL:");
  console.log("https://vercel.com/dashboard");
  console.log("\nOnce live, remember to run schema.sql only once per database (this script");
  console.log("already ran it for you) and re-run `node setup.js` any time you want to");
  console.log("re-sync + redeploy.");
}

main().catch((err) => {
  console.error(`\n❌ Setup failed: ${err.message}`);
  process.exit(1);
});
