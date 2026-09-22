// Direct-handler harness for the SSO bridge against the LIVE Neon DB
// with disposable TEST.* engineers, and the mock-his server in place of
// Bismarck's real platform. Cleans up after itself and re-verifies 331.
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { neonConfig, neon } from "@neondatabase/serverless";

// --- env: DATABASE_URL from .env.local, SSO pointed at the mock ---
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const MOCK = "http://127.0.0.1:4777";
process.env.SSO_BASE_URL = MOCK + "/api/v1";
process.env.SSO_CRED_KEY = "a".repeat(64);
process.env.NODE_ENV = "test";

// This machine's link to Neon drops intermittently — retry connect-level
// failures (they never reached the server, so retrying writes is safe).
const realFetch = globalThis.fetch;
neonConfig.fetchFunction = async (url, init) => {
  for (let i = 0; ; i++) {
    try { return await realFetch(url, init); }
    catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
};
const sql = neon(process.env.DATABASE_URL);
const { default: handler } = await import("../api/auth.js");

// --- fake req/res ---
async function call(action, { method = "GET", body, token, query = {} } = {}) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const req = Object.assign(Readable.from([buf]), {
    method, query: { action, ...query },
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    socket: { remoteAddress: "127.0.0.1" }, url: `/api/auth?action=${action}`,
  });
  const out = { status: 200, headers: {}, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    send(b) { out.body = b; return res; },
    end() { return res; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    getHeader(k) { return out.headers[k.toLowerCase()]; },
  };
  await handler(req, res);
  return out;
}
const ctl = (mode) => realFetch(MOCK + "/__ctl", { method: "POST", body: JSON.stringify({ mode }), headers: { "content-type": "application/json" } }).then(r => r.json());
const stats = () => realFetch(MOCK + "/__stats").then(r => r.json());

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (cond ? "" : "  " + JSON.stringify(extra)));
  if (!cond) failures++;
}

// --- disposable engineers ---
async function makeEngineer(num, email) {
  await sql`DELETE FROM engineers WHERE iek_number = ${"TEST." + num}`;
  const [e] = await sql`
    INSERT INTO engineers (iek_number, name, phone, email, display_name)
    VALUES (${"TEST." + num}, ${"TEST SSO " + num}, ${"+2547000" + num}, ${email}, ${"TEST SSO " + num})
    RETURNING id
  `;
  const first = await call("login", { method: "POST", body: { displayName: "TEST SSO " + num, membershipNumber: num, pin: "1234", email: email || "x@example.com", consentData: true, consentMarketing: false } });
  if (!first.body || !first.body.token) throw new Error("login failed: " + JSON.stringify(first.body));
  if (!email) await sql`UPDATE engineers SET email = NULL WHERE id = ${e.id}`;
  return { id: e.id, token: first.body.token };
}

try {
  await realFetch(MOCK + "/__reset", { method: "POST", body: "{}" });
  const [{ count: before }] = await sql`SELECT COUNT(*)::int AS count FROM engineers`;
  console.log("engineers before:", before);

  const a = await makeEngineer("90001", "test.sso.90001@example.com");
  const b = await makeEngineer("90002", "test.sso.90002@example.com");

  console.log("\n[1] status before anything");
  let r = await call("sso-login", { token: a.token });
  check("GET → linked:false", r.status === 200 && r.body.linked === false && r.body.status === "none", r.body);

  console.log("\n[2] first use registers an account on his side");
  r = await call("sso-login", { method: "POST", token: a.token });
  check("200 with token, created:true, origin registered", r.status === 200 && r.body.token && r.body.created === true && r.body.origin === "registered", r.body);
  let s = await stats();
  check("his register called once, one user exists", s.register === 1 && s.users === 1, s);
  const [row] = await sql`SELECT * FROM sso_identities WHERE engineer_id = ${a.id}`;
  check("row sealed: token_enc and credential_enc are not plaintext", row && row.token_enc.startsWith("v1.") && row.credential_enc.startsWith("v1.") && !row.token_enc.includes(r.body.token), row && { t: row.token_enc.slice(0, 12) });
  const tokenA1 = r.body.token;

  console.log("\n[3] second call is served from cache — no call to his API");
  r = await call("sso-login", { method: "POST", token: a.token });
  s = await stats();
  check("same token back", r.status === 200 && r.body.token === tokenA1, r.body);
  check("his API not called again", s.register === 1 && s.login === 0 && s.refresh === 0, s);

  console.log("\n[4] token nearly expired → rotated through /auth/refresh");
  await sql`UPDATE sso_identities SET token_expires_at = NOW() + INTERVAL '1 hour' WHERE engineer_id = ${a.id}`;
  r = await call("sso-login", { method: "POST", token: a.token });
  s = await stats();
  check("new token, refresh called once", r.status === 200 && r.body.token !== tokenA1 && s.refresh === 1, { body: r.body, s });
  const [row2] = await sql`SELECT token_expires_at FROM sso_identities WHERE engineer_id = ${a.id}`;
  check("expiry pushed ~30 days out", new Date(row2.token_expires_at).getTime() - Date.now() > 29 * 86400000, row2);

  console.log("\n[5] refresh rejected → falls back to the password we hold");
  await sql`UPDATE sso_identities SET token_expires_at = NOW() WHERE engineer_id = ${a.id}`;
  await ctl("refresh401");
  r = await call("sso-login", { method: "POST", token: a.token });
  s = await stats();
  check("new token via /auth/login", r.status === 200 && r.body.token && s.login === 1, { body: r.body, s });
  await ctl("ok");

  console.log("\n[6] password changed on his side → relink required, and not retried");
  await sql`UPDATE sso_identities SET token_expires_at = NOW() WHERE engineer_id = ${a.id}`;
  await ctl("refresh401");
  await sql`UPDATE sso_identities SET credential_enc = ${"v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"} WHERE engineer_id = ${a.id}`;
  r = await call("sso-login", { method: "POST", token: a.token });
  check("409 sso_relink_required", r.status === 409 && r.body.code === "sso_relink_required", r.body);
  const [row3] = await sql`SELECT status FROM sso_identities WHERE engineer_id = ${a.id}`;
  check("row marked broken", row3.status === "broken", row3);
  s = await stats();
  const loginsBefore = s.login;
  r = await call("sso-login", { method: "POST", token: a.token });
  s = await stats();
  check("repeat call short-circuits without hitting his API", r.status === 409 && s.login === loginsBefore, { body: r.body, s });
  await ctl("ok");

  console.log("\n[7] sso-link with wrong password");
  r = await call("sso-link", { method: "POST", token: a.token, body: { email: "test.sso.90001@example.com", password: "wrong-password" } });
  check("401 sso_invalid_credentials", r.status === 401 && r.body.code === "sso_invalid_credentials", r.body);

  console.log("\n[8] sso-link with the right password (member signs in there once)");
  const reg = await realFetch(MOCK + "/api/v1/auth/register", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ name: "B", email: "test.sso.90002@example.com", password: "known-password-123", account_type: "engineer", country_code: "KE" }) }).then(r => r.json());
  r = await call("sso-link", { method: "POST", token: b.token, body: { email: "test.sso.90002@example.com", password: "known-password-123" } });
  check("200 origin linked", r.status === 200 && r.body.origin === "linked" && r.body.token, r.body);
  const [rowB] = await sql`SELECT origin, credential_enc, external_user_id FROM sso_identities WHERE engineer_id = ${b.id}`;
  check("no password stored for a linked account", rowB.origin === "linked" && rowB.credential_enc === null && rowB.external_user_id === reg.user.id, rowB);

  console.log("\n[9] the same his-account can't be linked to a second member");
  r = await call("sso-link", { method: "POST", token: a.token, body: { email: "test.sso.90002@example.com", password: "known-password-123" } });
  check("409 sso_account_taken", r.status === 409 && r.body.code === "sso_account_taken", r.body);

  console.log("\n[10] first use when the member already has an account there");
  const c = await makeEngineer("90003", "test.sso.90002@example.com");
  r = await call("sso-login", { method: "POST", token: c.token });
  check("409 sso_account_exists", r.status === 409 && r.body.code === "sso_account_exists", r.body);

  console.log("\n[11] member with no email on file");
  const d = await makeEngineer("90004", null);
  r = await call("sso-login", { method: "POST", token: d.token });
  check("409 sso_email_required", r.status === 409 && r.body.code === "sso_email_required", r.body);

  console.log("\n[12] his platform down / in maintenance");
  await ctl("down");
  r = await call("sso-login", { method: "POST", token: b.token, query: { force: "1" } });
  check("503 sso_unavailable with Retry-After", r.status === 503 && r.body.code === "sso_unavailable" && r.headers["retry-after"] === "60", { body: r.body, h: r.headers });
  await ctl("maintenance");
  r = await call("sso-login", { method: "POST", token: b.token, query: { force: "1" } });
  check("503 sso_maintenance with Retry-After 300", r.status === 503 && r.body.code === "sso_maintenance" && r.headers["retry-after"] === "300", { body: r.body, h: r.headers });
  await ctl("ok");
  r = await call("me", { token: b.token });
  check("our own session untouched throughout", r.status === 200 && r.body.engineer && r.body.engineer.id === b.id, r.body && r.body.error);

  console.log("\n[13] concurrent first-use for one member");
  const e = await makeEngineer("90005", "test.sso.90005@example.com");
  const [r1, r2, r3] = await Promise.all([1, 2, 3].map(() => call("sso-login", { method: "POST", token: e.token })));
  s = await stats();
  check("all three 200", r1.status === 200 && r2.status === 200 && r3.status === 200, [r1.body, r2.body, r3.body]);
  const [[rowE], [{ count: rowsE }]] = await Promise.all([
    sql`SELECT origin, status FROM sso_identities WHERE engineer_id = ${e.id}`,
    sql`SELECT COUNT(*)::int AS count FROM sso_identities WHERE engineer_id = ${e.id}`,
  ]);
  check("exactly one row, linked", rowsE === 1 && rowE.status === "linked", { rowsE, rowE, users: s.users });

  console.log("\n[14] unlink");
  r = await call("sso-unlink", { method: "POST", token: b.token });
  const [gone] = await sql`SELECT 1 FROM sso_identities WHERE engineer_id = ${b.id}`;
  check("linked account row deleted, his token revoked", r.status === 200 && !gone && (await stats()).logout >= 1, r.body);
  r = await call("sso-unlink", { method: "POST", token: e.token });
  const [kept] = await sql`SELECT status, token_enc, credential_enc FROM sso_identities WHERE engineer_id = ${e.id}`;
  check("registered account row kept (unlinked) with its sealed password", kept && kept.status === "unlinked" && kept.token_enc === null && kept.credential_enc, kept);
  r = await call("sso-login", { method: "POST", token: e.token });
  check("re-login after unlink revives it through the stored password", r.status === 200 && r.body.origin === "registered", r.body);

  console.log("\n[15] wrong method / no session");
  r = await call("sso-login", { method: "DELETE", token: a.token });
  check("405", r.status === 405, r.body);
  r = await call("sso-login", { method: "POST" });
  check("401 without our session", r.status === 401, r.body);
} catch (err) {
  failures++;
  console.error("HARNESS ERROR", err);
} finally {
  console.log("\n--- cleanup ---");
  const del = await sql`DELETE FROM engineers WHERE iek_number LIKE ${"TEST.%"} RETURNING iek_number`;
  console.log("deleted:", del.map(r => r.iek_number).join(", ") || "(none)");
  const [{ count: left }] = await sql`SELECT COUNT(*)::int AS count FROM sso_identities`;
  const [{ count: after }] = await sql`SELECT COUNT(*)::int AS count FROM engineers`;
  console.log("sso_identities rows left:", left, "| engineers after:", after);
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}
