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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_candidates_position ON candidates(position)`;
  ok("Tables created! (existing engineers/votes/audit_log data is untouched — CREATE TABLE IF NOT EXISTS only adds what's missing)");

  step("Seeding sample engineers");
  const SAMPLE_ENGINEERS = [
    ["IEK001", "Eng. James Ochieng", "0712345678"],
    ["IEK002", "Eng. Mary Wanjiru", "0723456789"],
    ["IEK003", "Eng. Peter Mwangi", "0734567890"],
    ["IEK004", "Eng. Sarah Akinyi", "0745678901"],
    ["IEK005", "Eng. David Odhiambo", "0756789012"],
    ["IEK006", "Eng. Grace Njeri", "0767890123"],
    ["IEK007", "Eng. Michael Otieno", "0778901234"],
    ["IEK008", "Eng. Faith Wambui", "0789012345"],
  ];

  let inserted = 0;
  for (const [iekNumber, name, phone] of SAMPLE_ENGINEERS) {
    const result = await sql`
      INSERT INTO engineers (iek_number, name, phone)
      VALUES (${iekNumber}, ${name}, ${phone})
      ON CONFLICT (iek_number) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) inserted += 1;
  }
  ok(`${inserted} of ${SAMPLE_ENGINEERS.length} engineers seeded! (${SAMPLE_ENGINEERS.length - inserted} already existed)`);

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
