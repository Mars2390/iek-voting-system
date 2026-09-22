// Apply one additive migration file to the live Neon DB, statement by
// statement (the HTTP driver runs one statement per call).
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["]|["]$/g, "");
}
const sql = neon(process.env.DATABASE_URL);
const file = process.argv[2];
const text = readFileSync(file, "utf8").split(/\r?\n/).filter(l => !l.trim().startsWith("--")).join("\n");
const stmts = text.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
for (const s of stmts) { await sql.query(s); console.log("ok:", s.split("\n")[0].slice(0, 70)); }
const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM engineers`;
console.log("applied", stmts.length, "statements; engineers =", count);
