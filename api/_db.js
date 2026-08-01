// Shared Neon Postgres connection.
// Filename is prefixed with "_" so Vercel excludes it from routing —
// it's a helper module, not an API endpoint.

import { neon } from "@neondatabase/serverless";

let _sql = null;

// Lazy singleton: neon() throws if DATABASE_URL is missing, so we defer
// creating the client until the first real request instead of at import
// time (keeps bundling/build safe even if the env var isn't set yet).
export function getSql() {
  if (!_sql) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL environment variable is not set. Configure it in " +
        ".env.local (development) or Vercel Project Settings -> Environment Variables (production)."
      );
    }
    _sql = neon(process.env.DATABASE_URL);
  }
  return _sql;
}
