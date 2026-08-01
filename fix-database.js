#!/usr/bin/env node
// =========================================================
// IEK Voting System — Database Cleanup + Clean Re-import
//
//   node fix-database.js
//
// 1. Connects to Neon using DATABASE_URL from .env.local
// 2. Deletes rows whose iek_number is purely numeric (the
//    corrupted rows left behind by an earlier raw-file import)
// 3. Ensures the `candidates` table exists (idempotent)
// 4. Imports data/iek-voter-register-import.csv — existing real
//    IEK numbers are skipped (ON CONFLICT DO NOTHING), never
//    overwritten
//
// SECURITY: like setup.js, this file contains no database
// credentials. It reads DATABASE_URL from .env.local at runtime.
// Do not paste your connection string into this file — it's a
// committed source file, not a secrets file.
// =========================================================

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

function step(msg) { console.log(`\n${msg}`); }
function ok(msg) { console.log(`✅ ${msg}`); }
function warn(msg) { console.log(`⚠️  ${msg}`); }
function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------
// Load DATABASE_URL from .env.local (never hardcoded here)
// ---------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  if (!existsSync(envPath)) {
    fail(".env.local not found. Copy .env.example to .env.local and set your real Neon DATABASE_URL first.");
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
    fail("DATABASE_URL is missing or still a placeholder in .env.local.");
  }
}

// ---------------------------------------------------------
// Quote-aware CSV parsing
// ---------------------------------------------------------
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur); cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsvFile(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(parseCsvLine);
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------
async function main() {
  console.log("=================================================");
  console.log("  IEK VOTING SYSTEM — DATABASE FIX + RE-IMPORT");
  console.log("=================================================");

  loadEnvLocal();

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL);

  try {
    await sql`SELECT 1`;
  } catch (err) {
    fail(`Could not connect to the database: ${err.message}`);
  }
  ok("Connected to Neon.");

  // ---- 1. Find + delete corrupted rows ----
  step("🔍 Checking for corrupted data...");

  // Note: '[0-9]+' rather than '\d+' — deliberately avoids a JS template
  // literal footgun where a single backslash before a non-special
  // character (like \d) gets silently dropped, which would otherwise
  // send the wrong pattern to Postgres.
  const corrupted = await sql`
    SELECT id, iek_number, name FROM engineers WHERE iek_number ~ '^[0-9]+$' ORDER BY id
  `;

  let deletedCount = 0;
  if (corrupted.length === 0) {
    ok("No corrupted rows found — nothing to delete.");
  } else {
    console.log(`Found ${corrupted.length} corrupted row(s):`);
    corrupted.slice(0, 10).forEach((r) => console.log(`   id=${r.id}  iek_number="${r.iek_number}"  name="${r.name}"`));
    if (corrupted.length > 10) console.log(`   ... and ${corrupted.length - 10} more`);

    await sql`DELETE FROM engineers WHERE iek_number ~ '^[0-9]+$'`;
    deletedCount = corrupted.length;
    ok(`🗑️ Deleted ${deletedCount} corrupted rows`);
  }

  // ---- 2. Ensure candidates table exists ----
  step("🗳️  Ensuring candidates table exists...");
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
  ok("candidates table ready (existing data untouched if it already existed).");

  // ---- 3. Import the clean CSV ----
  const csvPath = path.join(__dirname, "data", "iek-voter-register-import.csv");
  if (!existsSync(csvPath)) {
    fail(`Could not find ${csvPath}. Make sure data/iek-voter-register-import.csv exists.`);
  }

  const rows = parseCsvFile(readFileSync(csvPath, "utf8"));
  const header = rows[0].map((h) => h.toLowerCase());
  const dataRows = rows.slice(1);

  const idx = {
    iek_number: header.indexOf("iek_number"),
    name: header.indexOf("name"),
    phone: header.indexOf("phone"),
    remarks: header.indexOf("remarks"),
  };
  if (idx.iek_number === -1 || idx.name === -1) {
    fail(`${csvPath} doesn't have the expected header (iek_number,name,phone,remarks). Found: ${header.join(", ")}`);
  }

  step(`📥 Importing ${dataRows.length} clean engineers...`);

  let inserted = 0;
  let skipped = 0;
  const failedRows = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const iekNumber = (row[idx.iek_number] || "").trim();
    const name = (row[idx.name] || "").trim();
    const phone = idx.phone !== -1 ? (row[idx.phone] || "").trim() : "";
    const remarks = idx.remarks !== -1 ? (row[idx.remarks] || "").trim() : "";

    if (!iekNumber || !name) {
      failedRows.push({ line: i + 2, reason: "missing iek_number or name" });
      continue;
    }

    try {
      const result = await sql`
        INSERT INTO engineers (iek_number, name, phone, remarks)
        VALUES (${iekNumber}, ${name}, ${phone || null}, ${remarks || null})
        ON CONFLICT (iek_number) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) inserted += 1;
      else skipped += 1;
    } catch (err) {
      failedRows.push({ line: i + 2, reason: err.message });
    }
  }

  ok(`✅ ${inserted} engineers imported successfully`);
  if (skipped > 0) console.log(`   ${skipped} already existed in the database — skipped, not overwritten.`);
  if (failedRows.length > 0) {
    warn(`${failedRows.length} row(s) could not be imported:`);
    failedRows.slice(0, 10).forEach((f) => console.log(`   line ${f.line}: ${f.reason}`));
    if (failedRows.length > 10) console.log(`   ... and ${failedRows.length - 10} more`);
  }

  // ---- Summary ----
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM engineers`;

  console.log("\n=================================================");
  console.log("🎉 Database is CLEAN and READY!");
  console.log("=================================================");
  console.log(`   Corrupted rows deleted:      ${deletedCount}`);
  console.log(`   New engineers imported:      ${inserted}`);
  console.log(`   Already existed (skipped):   ${skipped}`);
  console.log(`   Rows that failed to import:  ${failedRows.length}`);
  console.log(`   Total engineers in database: ${count}`);
  console.log("\nRefresh your live site to see the update.");
}

main().catch((err) => {
  console.error(`\n❌ fix-database.js failed: ${err.message}`);
  process.exit(1);
});
