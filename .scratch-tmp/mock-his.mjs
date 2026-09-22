// A stand-in for Bismarck's Laravel API with the exact shapes of his
// AuthController, so the SSO bridge can be exercised end to end without
// touching his real platform. Control endpoints flip failure modes.
import http from "node:http";
import { randomBytes } from "node:crypto";

const users = new Map();   // email -> { id, name, email, phone, password }
const tokens = new Map();  // token -> email
let mode = "ok";           // ok | down | maintenance | refresh401 | login401 | login429
const stats = { register: 0, login: 0, refresh: 0, me: 0, logout: 0 };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "X-API-Version": "v1" });
  res.end(JSON.stringify(body));
}
function userPayload(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone || null, phone_verified: false, account_type: "engineer", country_code: "KE", plan: "free", profile: { id: "p-" + u.id, slug: null, status: "draft", verification_status: "unverified", rating_avg: 0 } };
}
function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
function newToken(email) {
  const t = `${tokens.size + 1}|${randomBytes(20).toString("hex")}`;
  tokens.set(t, email);
  return t;
}

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/__ctl") { mode = body.mode; return json(res, 200, { mode }); }
  if (url.pathname === "/__stats") return json(res, 200, { ...stats, users: users.size, tokens: tokens.size, mode });
  if (url.pathname === "/__reset") { users.clear(); tokens.clear(); mode = "ok"; for (const k in stats) stats[k] = 0; return json(res, 200, { ok: true }); }

  if (mode === "down") { req.socket.destroy(); return; }
  if (mode === "maintenance") return json(res, 503, { message: "Engineers Hub is undergoing scheduled maintenance. Please try again shortly.", code: "maintenance" });
  if (req.headers.accept !== "application/json") return json(res, 500, { message: "Accept header missing" });

  const p = url.pathname.replace(/^\/api\/v1/, "");
  if (req.method === "POST" && p === "/auth/register") {
    stats.register++;
    for (const k of ["name", "email", "password", "account_type", "country_code"]) if (!body[k]) return json(res, 422, { message: `The ${k} field is required.` });
    if (String(body.password).length < 10) return json(res, 422, { message: "The password field must be at least 10 characters." });
    const email = String(body.email).toLowerCase();
    if (users.has(email)) return json(res, 422, { message: "Email already registered." });
    const u = { id: randomBytes(8).toString("hex"), name: body.name, email, phone: body.phone || null, password: body.password };
    users.set(email, u);
    return json(res, 201, { token: newToken(email), user: userPayload(u), otp_sent: !!body.phone });
  }
  if (req.method === "POST" && p === "/auth/login") {
    stats.login++;
    if (mode === "login429") return json(res, 429, { message: "Too many attempts. Try again later." });
    const u = users.get(String(body.email || "").toLowerCase());
    if (mode === "login401" || !u || u.password !== body.password) return json(res, 401, { message: "Invalid credentials." });
    return json(res, 200, { token: newToken(u.email), user: userPayload(u) });
  }
  const email = tokens.get(bearer(req));
  if (!email) return json(res, 401, { message: "Unauthenticated." });
  const u = users.get(email);
  if (req.method === "POST" && p === "/auth/refresh") {
    stats.refresh++;
    if (mode === "refresh401") return json(res, 401, { message: "Unauthenticated." });
    tokens.delete(bearer(req));
    return json(res, 200, { token: newToken(email), expires_in_minutes: 43200 });
  }
  if (req.method === "GET" && p === "/auth/me") { stats.me++; return json(res, 200, { user: userPayload(u) }); }
  if (req.method === "POST" && p === "/auth/logout") { stats.logout++; tokens.delete(bearer(req)); return json(res, 200, { message: "Signed out." }); }
  return json(res, 404, { message: "Not found." });
});
server.listen(Number(process.env.PORT || 4777), "127.0.0.1", () => console.log("mock-his listening on", server.address().port));
