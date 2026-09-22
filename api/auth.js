import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { put } from "@vercel/blob";
import { getSql } from "./_db.js";
import { applyCors, sendError, logAudit, getClientIp } from "./_utils.js";
import { sendViaSozuri, toSozuriMsisdn, smsIsConfigured } from "./_sozuri.js";
import { sendBulkEmail, sendEventInviteEmail, sendThreadEmail, verifyInboundWebhook, fetchReceivedEmail, extractThreadIdFromHeaders } from "./_email.js";

// The Engineer Hub member API. One file, many `?action=` values — NOT
// split into more files because this project sits at the Vercel Hobby
// plan's 12-function ceiling (see README "Serverless function count").
// Splitting this further would silently 404 the newest endpoints with
// no build error, exactly as documented there.
//
// Actions: login, logout, me, update-profile, consent, save-email,
// support, upload-photo, work-experience, education, skills, directory,
// connections, follows, feed, jobs, profile, dashboard,
// toggle-open-to-work, conversations, messages, admin-login,
// admin-logout, admin-me, admin-engineers, admin-import,
// admin-email-recipients, admin-send-email, admin-send-event-email,
// admin-email-logs, admin-email-templates, admin-support, admin-support-reply,
// and the Voting system: elections, campaigns, upload-campaign-photo,
// ballot, vote, election-results, campaign-sms-recipients, campaign-sms,
// campaign-sms-batch, campaign-sms-dispatch (see the VOTING section),
// and the SSO bridge to Engineers Hub: sso-login, sso-link, sso-unlink
// (see the SSO BRIDGE section).
//
// A membership number is not a secret — it's a lookup key, not a
// credential — so login also requires a PIN the member sets on their
// own first login (see the `login` action below). The number itself is
// still never shown to anyone but its owner (see publicEngineer),
// since it doubles as the login username.

const SESSION_DAYS = 30;
// Client compresses images before upload (hub-common.js compressImage),
// so real-world photos land well under this — it's a safety net for
// the rare case compression falls back to the original file.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB
// No client-side video compression (Canvas can't touch video, and
// re-encoding video server-side needs ffmpeg, which isn't available
// in this runtime) — this cap is the only size control. Set just under
// Vercel's own 100MB request-body ceiling so a too-large upload gets
// this action's own clear error message instead of a raw platform
// rejection; still generous enough for a real few-minute phone video
// (40MB was unrealistically tight — a 1080p clip from a modern phone
// blows past that in under 30 seconds).
const MAX_VIDEO_BYTES = 95 * 1024 * 1024; // 95MB
// Message attachments: images reuse MAX_PHOTO_BYTES. Generic files (CVs,
// drawings, PDFs) capped lower than video — a chat attachment realistically
// doesn't need to be a huge file, and keeping it well under Vercel's 100MB
// body ceiling keeps uploads fast on the mobile data most members are on.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB
// A voice note is compressed audio (opus/aac, not raw), so even several
// minutes stays small — this is generous headroom, not a realistic ceiling.
const MAX_VOICE_BYTES = 15 * 1024 * 1024; // 15MB
const REACTION_TYPES = ["like", "love", "celebrate", "laugh", "wow", "sad", "angry"];
const TYPING_WINDOW_MS = 8000;

// ---- SSO bridge to Engineers Hub (Bismarck's Laravel 12 + Sanctum) ----
// See migrations/017_sso.sql and the SSO BRIDGE section below. His API
// is only ever called from here, server-to-server; the browser reaches
// it through the same-origin rewrite /api/his-backend/* in vercel.json.
const SSO_BASE_URL = String(process.env.SSO_BASE_URL || "https://www.engineershub.africa/api/v1").replace(/\/+$/, "");
// Mirrors his SANCTUM_TOKEN_TTL_MINUTES default. Only /auth/refresh tells
// us the real TTL; register/login don't, so this is the assumption for those.
const SSO_TOKEN_TTL_MINUTES = Number(process.env.SSO_TOKEN_TTL_MINUTES || 43200); // 30 days
// A cached token is handed to the client only with at least this much
// life left; otherwise it's rotated first. A day gives a member's open
// tab or app a full session before anything can expire under it.
const SSO_TOKEN_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;
// A hanging Laravel host must not sit inside our function for long — the
// PIN login that every member already has is the fallback, not a wait.
const SSO_TIMEOUT_MS = 8000;
const SSO_DEVICE_NAME = "engineer-hub-sso";
// His /auth/register sends a verification-code SMS to any phone it is
// given — from HIS platform, in HIS name, to a member who only pressed
// a button here. Off by default; flip on once that message is expected.
const SSO_REGISTER_WITH_PHONE = process.env.SSO_REGISTER_WITH_PHONE === "1";

// Admin panel access — intentionally a short allowlist + shared PIN, not
// tied to the engineers table at all (an admin need not be one of the
// 317 registered engineers). Same "documented, not hidden" convention
// as the membership-number login above: this is deliberately minimal,
// by request, not an oversight.
const ADMIN_EMAILS = ["albertmomanyi07@gmail.com", "starikonyamori@gmail.com"];
const ADMIN_PIN = "0000";
const ADMIN_SESSION_DAYS = 7;

// Vercel's (req, res)-style Node functions only auto-parse req.body for
// application/json, application/x-www-form-urlencoded, and text/plain —
// for anything else (image/jpeg etc.) req.body is left unset, so photo
// uploads have to read the raw request stream themselves.
async function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function digitsOnly(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

// scrypt is built into node:crypto — no extra dependency needed for
// real password-grade hashing. Salt travels alongside the hash in the
// same stored string ("salt:hash", both hex) since scrypt needs the
// exact salt back to re-derive and compare.
function hashPin(pin) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pin, salt, 64).toString("hex");
  return salt + ":" + hash;
}
function verifyPin(pin, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(pin, salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
function isValidPin(pin) {
  return /^[0-9]{4,6}$/.test(String(pin || ""));
}

function getToken(req) {
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return bearer || req.query.token || (req.body && req.body.token) || "";
}

async function requireSession(sql, req, res) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: "Not signed in." });
    return null;
  }
  const [session] = await sql`
    SELECT s.id AS session_id, s.expires_at, (s.expires_at < NOW()) AS is_expired, e.*
    FROM sessions s
    JOIN engineers e ON e.id = s.engineer_id
    WHERE s.token = ${token}
  `;
  if (!session || session.is_expired) {
    res.status(401).json({ error: "Your session has expired. Please log in again." });
    return null;
  }
  // Awaited (concurrently, so it costs one round trip rather than two)
  // rather than fire-and-forget — this runs on every authenticated
  // request, so an unawaited write here is the same "serverless function
  // can be torn down before its own pending write completes" bug found
  // and fixed for profile views, just far more consequential since it
  // backs "active now"/"last active Xm ago" everywhere in the app.
  await Promise.all([
    sql`UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ${session.session_id}`.catch(() => {}),
    sql`UPDATE engineers SET last_active = CURRENT_TIMESTAMP WHERE id = ${session.id}`.catch(() => {}),
  ]);
  return session;
}

async function requireAdminSession(sql, req, res) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: "Not signed in." });
    return null;
  }
  const [session] = await sql`
    SELECT id, email, (expires_at < NOW()) AS is_expired FROM admin_sessions WHERE token = ${token}
  `;
  if (!session || session.is_expired) {
    res.status(401).json({ error: "Your admin session has expired. Please log in again." });
    return null;
  }
  return session;
}

// Full self-view: everything, including phone (own record only).
function privateEngineer(e) {
  return {
    id: e.id,
    iekNumber: e.iek_number,
    displayName: e.display_name || e.name,
    registeredName: e.name,
    phone: e.phone,
    email: e.email,
    discipline: e.discipline,
    company: e.company,
    title: e.title,
    location: e.location,
    bio: e.bio,
    experienceYears: e.experience_years,
    profilePhoto: e.profile_photo,
    coverPhoto: e.cover_photo,
    linkedinUrl: e.linkedin_url,
    githubUrl: e.github_url,
    portfolioUrl: e.portfolio_url,
    lastLogin: e.last_login,
    lastActive: e.last_active,
    openToWork: !!e.open_to_work,
    verified: true,
    consentDataAt: e.consent_data_at,
    consentMarketing: !!e.consent_marketing,
    consentMarketingAt: e.consent_marketing_at,
  };
}

// Public-facing view of someone else's profile: no phone number, and
// no membership number — phone comes from the IEK voter register and
// was never meant for public display, and the membership number
// doubles as the login username (see the `login` action), so showing
// it to other members would hand out the one thing needed to attempt
// logging in as that person.
function publicEngineer(e) {
  const priv = privateEngineer(e);
  delete priv.phone;
  delete priv.iekNumber;
  return priv;
}

function mapJob(j) {
  return {
    id: j.id,
    title: j.title,
    companyName: j.company_name,
    location: j.location,
    jobType: j.job_type,
    discipline: j.discipline,
    description: j.description,
    applyUrl: j.apply_url,
    applyEmail: j.apply_email,
    salaryMin: j.salary_min,
    salaryMax: j.salary_max,
    postedBy: j.poster_name || j.poster_registered_name || "Engineer Hub member",
    postedById: j.posted_by,
    createdAt: j.created_at,
  };
}

async function logActivity(sql, engineerId, actionType, description) {
  await sql`
    INSERT INTO activity_feed (engineer_id, action_type, description)
    VALUES (${engineerId}, ${actionType}, ${description})
  `.catch(() => {});
}

// Personal, per-recipient notifications (bell icon) — distinct from
// activity_feed, which is a public log of everyone's actions. Never
// notify someone about their own action (e.g. liking your own post).
async function notify(sql, recipientId, actorId, type, targetType, targetId) {
  if (recipientId === actorId) return;
  await sql`
    INSERT INTO notifications (recipient_id, actor_id, type, target_type, target_id)
    VALUES (${recipientId}, ${actorId}, ${type}, ${targetType}, ${targetId})
  `.catch(() => {});
}

// Single source of truth for both the dashboard's completion percentage
// and its "here's what's missing" list — profile.js's own nudges
// checklist used to check a different, shorter set of fields than this
// function scored, so the percentage and the visible checklist silently
// disagreed (e.g. company/location/discipline counted toward the score
// with nothing telling the member to fill them in). One list now drives
// both, with a jump-to anchor for anything editable from the profile page.
// event_at is a naive wall-clock value with no timezone marker (see the
// long comment on the `events` action) — formatting it for the
// invitation email has to stay a plain string operation, the same as
// TO_CHAR does for the API response, instead of round-tripping through
// `new Date(...)`, which would silently reinterpret it in whatever
// timezone this function happens to run in.
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatWallClockDate(eventAtStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(eventAtStr || ""));
  if (!m) return String(eventAtStr || "");
  const [, year, month, day, hour, minute] = m;
  const h = Number(hour);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${Number(day)} ${MONTH_NAMES[Number(month) - 1]} ${year}, ${h12}:${minute} ${ampm}`;
}

function computeProfileCompletion(e, counts) {
  const checks = [
    { done: !!e.email, label: "Add your email address", anchor: "#pf-contact-edit-btn" },
    { done: !!e.bio, label: "Write a short bio", anchor: "#pf-about-edit-btn" },
    { done: !!e.title, label: "Add your job title", anchor: "#pf-details-edit-btn" },
    { done: !!e.company, label: "Add your company", anchor: "#pf-details-edit-btn" },
    { done: !!e.location, label: "Add your location", anchor: "#pf-details-edit-btn" },
    { done: !!e.discipline, label: "Add your engineering discipline", anchor: "#pf-details-edit-btn" },
    { done: !!e.experience_years, label: "Add your years of experience", anchor: "#pf-details-edit-btn" },
    { done: !!e.profile_photo, label: "Add a profile photo", anchor: "#pf-avatar-edit" },
    { done: counts.experience > 0, label: "Add your work experience", anchor: "#pf-exp-add-btn" },
    { done: counts.education > 0, label: "Add your education", anchor: "#pf-edu-add-btn" },
    { done: counts.skills > 0, label: "Add at least one skill", anchor: null },
  ];
  const done = checks.filter((c) => c.done).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    missing: checks.filter((c) => !c.done).map((c) => ({ label: c.label, anchor: c.anchor })),
  };
}

// ---------- Voting: elections, campaigns, ballots, campaign SMS ----------
// See migrations/016_elections.sql and the VOTING section of the handler.
const CAMPAIGN_SMS_DAILY_LIMIT = 3;     // batches per campaign per rolling 24h — every send draws on the shared Sozuri credit
const CAMPAIGN_SMS_MAX_CHARS = 300;     // the candidate's own text; the auto-signature (name + vote link) is added on top
const SMS_DISPATCH_CHUNK = 15;          // recipients claimed per dispatch call — keeps each call well inside one request
const SMS_DISPATCH_CONCURRENCY = 3;
const CAMPAIGN_MAX_DAYS = 180;

// An election's effective phase, computed in SQL so every reader (ballot,
// results, admin list, vote acceptance) agrees to the millisecond, and so
// the admin's manual "close now" (closed_at) and the scheduled window
// (opens_at/closes_at) are compared against the same NOW(). All three
// columns are TIMESTAMPTZ instants — never the naive wall-clock TIMESTAMP
// that `events` uses — because a ballot is *accepted or rejected* on this
// comparison, which has to be unambiguous regardless of server timezone.
function electionPhaseSql(alias, closedLabel = "closed") {
  const a = alias ? alias + "." : "";
  return `CASE
    WHEN ${a}closed_at IS NOT NULL OR (${a}closes_at IS NOT NULL AND ${a}closes_at <= NOW()) THEN '${closedLabel}'
    WHEN ${a}opens_at IS NULL OR ${a}opens_at > NOW() THEN 'upcoming'
    ELSE 'live' END`;
}
// A campaign's phase: inside an official election it's the election's
// window; an independent campaign runs on its own starts_at/ends_at.
const CAMPAIGN_PHASE_SQL = `CASE
    WHEN c.status = 'withdrawn' THEN 'withdrawn'
    WHEN c.election_id IS NOT NULL THEN ${electionPhaseSql("e", "ended")}
    WHEN c.ends_at IS NOT NULL AND c.ends_at <= NOW() THEN 'ended'
    WHEN c.starts_at IS NOT NULL AND c.starts_at > NOW() THEN 'upcoming'
    ELSE 'live' END`;
// $1 is always the viewer's engineer id (NULL for an admin session) so
// each campaign row can carry "did this viewer already vote for it".
const CAMPAIGN_SELECT_SQL = `
  SELECT c.*,
         e.title AS election_title,
         e.winners_announced_at AS election_winners_announced_at,
         ${electionPhaseSql("e")} AS election_phase,
         cr.display_name AS creator_display_name, cr.name AS creator_name, cr.profile_photo AS creator_photo,
         cr.title AS creator_title, cr.company AS creator_company, cr.discipline AS creator_discipline,
         (SELECT COUNT(*) FROM campaign_votes v WHERE v.campaign_id = c.id)::int AS votes,
         EXISTS(SELECT 1 FROM campaign_votes v WHERE v.campaign_id = c.id AND v.voter_id = $1::int) AS my_voted,
         ${CAMPAIGN_PHASE_SQL} AS phase
  FROM campaigns c
  LEFT JOIN elections e ON e.id = c.election_id
  JOIN engineers cr ON cr.id = c.creator_id`;

function mapElection(e) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    positions: Array.isArray(e.positions) ? e.positions : [],
    opensAt: e.opens_at,
    closesAt: e.closes_at,
    closedAt: e.closed_at,
    phase: e.phase,
    nominationsOpen: !!e.nominations_open,
    autoVerify: !!e.auto_verify,
    winnersAnnouncedAt: e.winners_announced_at,
    candidateCount: Number(e.candidate_count || 0),
    verifiedCount: Number(e.verified_count || 0),
    pendingCount: Number(e.candidate_count || 0) - Number(e.verified_count || 0),
    voteCount: Number(e.vote_count || 0),
    voterCount: Number(e.voter_count || 0),
    createdAt: e.created_at,
  };
}

function mapCampaign(c, viewerId) {
  const phase = c.phase;
  const inElection = c.election_id != null;
  return {
    id: c.id,
    electionId: c.election_id,
    electionTitle: c.election_title || null,
    electionPhase: c.election_phase || null,
    electionWinnersAnnouncedAt: c.election_winners_announced_at || null,
    creatorId: c.creator_id,
    candidateName: c.creator_display_name || c.creator_name,
    creatorTitle: c.creator_title,
    creatorCompany: c.creator_company,
    creatorDiscipline: c.creator_discipline,
    name: c.name,
    position: c.position,
    bio: c.bio,
    // A campaign without its own photo falls back to the candidate's
    // profile photo — most members will have one before they have a
    // campaign poster.
    photoUrl: c.photo_url || c.creator_photo || null,
    hasOwnPhoto: !!c.photo_url,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    status: c.status,
    verified: !!c.verified,
    phase,
    isLive: phase === "live",
    // Inside an official election only admin-verified candidates are on
    // the ballot; an independent campaign needs no verification.
    canReceiveVotes: phase === "live" && (!inElection || !!c.verified),
    votes: Number(c.votes || 0),
    myVoted: !!c.my_voted,
    isOwner: viewerId != null && c.creator_id === viewerId,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

async function getAdminSessionSilently(sql, req) {
  const token = getToken(req);
  if (!token) return null;
  const [s] = await sql`SELECT id, email FROM admin_sessions WHERE token = ${token} AND expires_at > NOW()`;
  return s || null;
}

// Several voting reads are shared by the member pages and the admin
// panel (which has an entirely separate token/table). Try the admin
// token silently first — only requireSession's failure path writes a
// response — then fall back to a member session for everyone else.
async function requireMemberOrAdmin(sql, req, res) {
  const admin = await getAdminSessionSilently(sql, req);
  if (admin) return { admin, member: null, viewerId: null };
  const member = await requireSession(sql, req, res);
  if (!member) return null;
  return { admin: null, member, viewerId: member.id };
}

function cleanPositions(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/\r?\n|,/);
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    const s = String(p || "").trim().replace(/\s+/g, " ").slice(0, 120);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(0, 20);
}

function parseInstant(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function campaignLink(req, campaignId) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || "engineer-hubb.vercel.app";
  return `https://${host}/campaign.html?id=${campaignId}`;
}

async function notifyAllEngineers(sql, type, targetType, targetId) {
  await sql`
    INSERT INTO notifications (recipient_id, actor_id, type, target_type, target_id)
    SELECT id, NULL, ${type}, ${targetType}, ${targetId} FROM engineers
  `.catch(() => {});
}

// =========================================================
// SSO BRIDGE — Engineers Hub (Bismarck's Laravel 12 + Sanctum)
//
// A member logs in HERE once (IEK number + PIN) and can then use the
// Laravel-backed features — marketplace, courses, payments — without a
// second login. These helpers obtain a Sanctum token on the member's
// behalf, keep it sealed in sso_identities, rotate it through his
// POST /auth/refresh before it expires, and hand it to the client, which
// then calls his API through /api/his-backend/* with it.
//
// Two ways an engineer gets an Engineers Hub account:
//   registered — created for them on first use with a random password
//                only this backend has seen (sealed at rest). His
//                register endpoint returns a token immediately, so this
//                path needs nothing from Bismarck to work.
//   linked     — they already had one. They sign in to it once via
//                `sso-link`; the password is forwarded to his
//                /auth/login and discarded, and only the token is kept.
//
// His API is never the authority for OUR session — requireSession()
// stays the only gate on every action in this file. If his platform is
// down, the SSO actions answer 503 and nothing else in the app changes.
// =========================================================

function ssoKey() {
  const hex = String(process.env.SSO_CRED_KEY || "").trim();
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

// AES-256-GCM, written as "v1.<iv>.<tag>.<ciphertext>" in base64url so a
// later key or algorithm change can be told apart from older rows.
function sealSecret(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ssoKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
function openSecret(sealed) {
  const [v, iv, tag, ct] = String(sealed || "").split(".");
  if (v !== "v1" || !iv || !tag || !ct) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", ssoKey(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null; // wrong key or tampered row — treated as "no token"
  }
}

// One outbound call to his API. Never throws for an HTTP status — callers
// read { ok, status, data }. A host that can't be reached at all comes
// back as code "unavailable", and his maintenance-mode 503 as
// "maintenance", so no action here ever leaks a stack trace about
// somebody else's server into a member's screen.
async function hisApi(path, { method = "GET", body, token } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SSO_TIMEOUT_MS);
  try {
    const r = await fetch(SSO_BASE_URL + path, {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": "EngineerHub-SSO/1 (+https://engineer-hubb.vercel.app)",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    const code = r.status === 503 && data && data.code === "maintenance" ? "maintenance" : null;
    return { ok: r.ok, status: r.status, data: data || {}, code };
  } catch (err) {
    const detail = err && err.name === "AbortError" ? "timeout" : String((err && err.message) || err);
    return { ok: false, status: 0, data: {}, code: "unavailable", detail };
  } finally {
    clearTimeout(timer);
  }
}

// 503 with a stable code the clients switch on. Retry-After mirrors his.
function ssoDown(res, r) {
  const maintenance = r.code === "maintenance";
  res.setHeader("Retry-After", maintenance ? "300" : "60");
  return res.status(503).json({
    code: maintenance ? "sso_maintenance" : "sso_unavailable",
    error: maintenance
      ? "Engineers Hub is under scheduled maintenance. Everything else here still works."
      : "Engineers Hub sign-in is unavailable right now. Everything else here still works.",
  });
}

// What every successful SSO action returns. `expiresAt` lets the client
// ask for a fresh token before this one runs out rather than after.
function ssoTokenPayload(token, expiresAt, origin, extra = {}) {
  return { token, expiresAt, origin, linked: true, ...extra };
}

// Body parsing is off (see the raw-body read at the top of the handler
// below) because the inbound-webhook action needs the exact raw bytes
// Resend signed — Vercel's default JSON auto-parse would consume the
// request stream before that action ever saw it, and re-serializing an
// already-parsed object back to JSON isn't guaranteed to byte-for-byte
// match what was actually signed (key order, whitespace). Every other
// action is unaffected: the handler replicates the same JSON auto-parse
// itself, just after keeping a copy of the raw bytes first.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const { action } = req.query;

  // Read the raw body exactly once. JSON requests get parsed into
  // req.body (same shape every existing action already expects); a
  // parse failure just leaves req.body as {} rather than 500ing every
  // action up front, since some actions (GETs, multipart-ish image/
  // Excel uploads handled via req.rawBody/readRawBody directly) never
  // had a JSON body to parse in the first place.
  const rawBodyBuffer = await readRawBody(req);
  req.rawBody = rawBodyBuffer;
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      req.body = rawBodyBuffer.length ? JSON.parse(rawBodyBuffer.toString("utf8")) : {};
    } catch (e) {
      req.body = {};
    }
  } else {
    req.body = rawBodyBuffer;
  }

  try {
    // =========================================================
    // AUTH
    // =========================================================
    if (action === "login") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }

      const { displayName, membershipNumber, pin, consentData, consentMarketing, email: signupEmail } = req.body || {};
      const digits = digitsOnly(membershipNumber);
      if (!digits) {
        return res.status(400).json({ error: "Enter your membership number." });
      }

      // is_pin_locked/pin_lock_minutes_left are computed in SQL, not from
      // parsing pin_locked_until client-side — pin_locked_until is a
      // naive TIMESTAMP (no timezone), and a naive value's wall-clock
      // reading only means what it's supposed to if the reading
      // process's own system timezone happens to be UTC, which isn't
      // guaranteed (see the identical footgun already documented for
      // `last_active` elsewhere in this file).
      const [engineer] = await sql`
        SELECT *,
               (pin_locked_until IS NOT NULL AND pin_locked_until > NOW()) AS is_pin_locked,
               GREATEST(1, CEIL(EXTRACT(EPOCH FROM (pin_locked_until - NOW())) / 60))::int AS pin_lock_minutes_left
        FROM engineers
        WHERE regexp_replace(iek_number, '[^0-9]', '', 'g') = ${digits}
      `;
      if (!engineer) {
        return res.status(404).json({
          error: "We couldn't find that membership number. Check the digits and try again.",
        });
      }

      if (engineer.is_pin_locked) {
        const minutesLeft = engineer.pin_lock_minutes_left;
        return res.status(429).json({
          error: `Too many incorrect PIN attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`,
        });
      }

      if (!engineer.pin_hash) {
        // No PIN on this account yet — the member's own next login is
        // what sets one (see migrations/009_pin_auth.sql), since there's
        // no verified phone/email channel to issue one through instead.
        if (!pin) {
          return res.status(200).json({ needsPinSetup: true, name: engineer.display_name || engineer.name });
        }
        if (!isValidPin(pin)) {
          return res.status(400).json({ error: "PIN must be 4-6 digits." });
        }
        // Required consent to be processed at all — captured once, here,
        // at the same moment the account is actually activated. The
        // marketing opt-in is separate and freely revocable later from
        // Settings (see the update-profile action).
        if (!consentData) {
          return res.status(400).json({ error: "Please accept the Privacy Policy and Terms of Use to continue." });
        }
        const marketingOptIn = !!consentMarketing;
        // Required — an email is how the platform reaches engineers for
        // event notices, support replies, and account recovery, so
        // account activation is gated on having a real-looking one on
        // file. Re-checked here rather than trusted from the client:
        // login.js already blocks submission client-side, but that's a
        // UX convenience, not the actual enforcement.
        const trimmedEmail = String(signupEmail || "").trim();
        if (!trimmedEmail) {
          return res.status(400).json({ error: "Email is required to proceed." });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
          return res.status(400).json({ error: "Enter a valid email address." });
        }
        await sql`
          UPDATE engineers SET pin_hash = ${hashPin(pin)}, pin_set_at = CURRENT_TIMESTAMP, failed_pin_attempts = 0,
            consent_data_at = CURRENT_TIMESTAMP,
            consent_marketing = ${marketingOptIn},
            consent_marketing_at = ${marketingOptIn ? new Date() : null},
            email = ${trimmedEmail.slice(0, 150)}
          WHERE id = ${engineer.id}
        `;
      } else {
        if (!pin) {
          return res.status(200).json({ needsPin: true, name: engineer.display_name || engineer.name });
        }
        if (!verifyPin(pin, engineer.pin_hash)) {
          const attempts = (engineer.failed_pin_attempts || 0) + 1;
          if (attempts >= 5) {
            await sql`
              UPDATE engineers SET failed_pin_attempts = 0, pin_locked_until = NOW() + INTERVAL '15 minutes'
              WHERE id = ${engineer.id}
            `;
            return res.status(429).json({ error: "Too many incorrect PIN attempts. Try again in 15 minutes." });
          }
          await sql`UPDATE engineers SET failed_pin_attempts = ${attempts} WHERE id = ${engineer.id}`;
          return res.status(401).json({ error: `Incorrect PIN. ${5 - attempts} attempt${5 - attempts === 1 ? "" : "s"} remaining.` });
        }
        if (engineer.failed_pin_attempts) {
          await sql`UPDATE engineers SET failed_pin_attempts = 0 WHERE id = ${engineer.id}`;
        }
      }

      const cleanName = String(displayName || "").trim().slice(0, 150);
      const token = randomBytes(32).toString("hex");
      const isFirstLogin = !engineer.last_login;

      const [updated] = await sql`
        UPDATE engineers
        SET last_login = CURRENT_TIMESTAMP,
            last_active = CURRENT_TIMESTAMP,
            display_name = COALESCE(NULLIF(display_name, ''), NULLIF(${cleanName}, ''))
        WHERE id = ${engineer.id}
        RETURNING *
      `;

      await sql`
        INSERT INTO sessions (token, engineer_id, expires_at)
        VALUES (${token}, ${engineer.id}, NOW() + (${SESSION_DAYS}::int * INTERVAL '1 day'))
      `;

      if (isFirstLogin) {
        await logActivity(sql, engineer.id, "joined", `${updated.display_name || updated.name} joined Engineer Hub`);
      }

      return res.status(200).json({ token, engineer: privateEngineer(updated) });
    }

    if (action === "logout") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const token = getToken(req);
      if (token) await sql`DELETE FROM sessions WHERE token = ${token}`;
      return res.status(200).json({ success: true });
    }

    if (action === "logout-all") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      await sql`DELETE FROM sessions WHERE engineer_id = ${session.id}`;
      return res.status(200).json({ success: true });
    }

    if (action === "me") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      return res.status(200).json({ engineer: privateEngineer(session) });
    }

    if (action === "update-profile") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const b = req.body || {};
      const trim = (v, max) => {
        const s = String(v ?? "").trim().slice(0, max);
        return s || null;
      };
      const [updated] = await sql`
        UPDATE engineers
        SET display_name = ${trim(b.displayName, 150) || session.display_name},
            discipline = ${trim(b.discipline, 100)},
            company = ${trim(b.company, 150)},
            title = ${trim(b.title, 150)},
            location = ${trim(b.location, 150)},
            bio = ${trim(b.bio, 2000)},
            email = ${trim(b.email, 150)},
            linkedin_url = ${trim(b.linkedinUrl, 300)},
            github_url = ${trim(b.githubUrl, 300)},
            portfolio_url = ${trim(b.portfolioUrl, 300)},
            experience_years = ${Number.isFinite(Number(b.experienceYears)) && b.experienceYears !== "" ? Number(b.experienceYears) : null},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${session.id}
        RETURNING *
      `;
      await logActivity(sql, session.id, "profile_updated", `${updated.display_name || updated.name} updated their profile`);
      return res.status(200).json({ engineer: privateEngineer(updated) });
    }

    // Separate from update-profile on purpose: that action unconditionally
    // overwrites every profile field from the request body, so reusing it
    // for a lone consent toggle would blank out bio/company/title/etc. on
    // any call that didn't also resend them. Only the marketing opt-in is
    // editable here — the required data-processing consent is captured
    // once at account setup (see the `login` action) and isn't something
    // a checkbox can silently revoke while the account stays active.
    if (action === "consent") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const marketingOptIn = !!(req.body || {}).consentMarketing;
      const [updated] = await sql`
        UPDATE engineers SET
          consent_marketing = ${marketingOptIn},
          consent_marketing_at = ${marketingOptIn ? new Date() : null}
        WHERE id = ${session.id}
        RETURNING *
      `;
      return res.status(200).json({ engineer: privateEngineer(updated) });
    }

    // Also separate from update-profile for the same reason as `consent`
    // above — used by the one-field "add your email" prompts (first
    // login, dashboard/profile nudge) that shouldn't risk blanking the
    // rest of the profile if they're ever called without every field.
    if (action === "save-email") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const email = String((req.body || {}).email || "").trim().slice(0, 150);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: "Enter a valid email address." });
      }
      const [updated] = await sql`
        UPDATE engineers SET email = ${email}, updated_at = CURRENT_TIMESTAMP WHERE id = ${session.id} RETURNING *
      `;
      return res.status(200).json({ engineer: privateEngineer(updated) });
    }

    // =========================================================
    // SUPPORT — a Gmail-style thread per conversation, not one flat
    // message+reply row (see migrations/015_support_threads.sql for
    // why). Engineers only ever see and create their own threads;
    // admins see everyone's (admin-support* actions, grouped with the
    // other admin-* actions further down, alongside inbound-webhook —
    // the endpoint Resend calls when someone replies by email instead
    // of through this page).
    // =========================================================
    if (action === "support") {
      if (req.method === "GET") {
        const session = await requireSession(sql, req, res);
        if (!session) return;
        const threads = await sql`
          SELECT id, subject, status, created_at, last_message_at
          FROM support_threads WHERE engineer_id = ${session.id} ORDER BY last_message_at DESC
        `;
        if (!threads.length) return res.status(200).json({ threads: [] });
        const ids = threads.map((t) => t.id);
        const messages = await sql`
          SELECT thread_id, sender_type, body, created_at FROM support_thread_messages
          WHERE thread_id = ANY(${ids}) ORDER BY created_at ASC
        `;
        return res.status(200).json({
          threads: threads.map((t) => ({
            id: t.id, subject: t.subject, status: t.status, createdAt: t.created_at, lastMessageAt: t.last_message_at,
            messages: messages.filter((m) => m.thread_id === t.id).map((m) => ({ senderType: m.sender_type, body: m.body, createdAt: m.created_at })),
          })),
        });
      }
      if (req.method === "POST") {
        const session = await requireSession(sql, req, res);
        if (!session) return;
        const b = req.body || {};
        const subject = String(b.subject || "").trim().slice(0, 255);
        const message = String(b.message || "").trim().slice(0, 5000);
        if (!subject || !message) return res.status(400).json({ error: "Add a subject and a message." });
        const [thread] = await sql`
          INSERT INTO support_threads (engineer_id, sender_name, sender_email, subject)
          VALUES (${session.id}, ${session.display_name || session.name}, ${session.email}, ${subject})
          RETURNING *
        `;
        await sql`
          INSERT INTO support_thread_messages (thread_id, sender_type, sender_name, sender_email, body)
          VALUES (${thread.id}, 'engineer', ${session.display_name || session.name}, ${session.email}, ${message})
        `;
        return res.status(201).json({ thread: { id: thread.id, subject: thread.subject, status: thread.status, createdAt: thread.created_at } });
      }
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // Resend calls this when an email arrives at the reply-to address
    // (see api/_email.js's emailReplyTo doc comment for why that's a
    // different address from NES@engineerhuub.com itself). No session —
    // this is a server-to-server call, authenticated by the Resend
    // webhook signature instead (verifyInboundWebhook throws on a bad
    // one, same effect as a rejected session).
    if (action === "inbound-webhook") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      // Not readRawBody(req) here — for a JSON request (which this always
      // is) the top-of-handler step above already parsed req.body into an
      // object, so re-reading a Buffer.isBuffer(req.body) fast path would
      // find neither a Buffer nor a live stream. req.rawBody is the exact
      // pre-parse bytes saved for precisely this reason.
      let event;
      try {
        event = verifyInboundWebhook(req.rawBody.toString("utf8"), req.headers);
      } catch (err) {
        // "Not configured" isn't security-sensitive (it doesn't help
        // forge a signature) and is genuinely useful for confirming
        // RESEND_WEBHOOK_SECRET actually made it into this deployment —
        // worth a distinct message from an actual bad/forged signature.
        const notConfigured = /RESEND_WEBHOOK_SECRET/.test(err.message || "");
        return res.status(401).json({ error: notConfigured ? "Inbound email is not configured yet (RESEND_WEBHOOK_SECRET is unset)." : "Invalid webhook signature." });
      }
      // Resend can retry a webhook delivery, and this endpoint may also
      // be subscribed to event types beyond email.received (harmless to
      // receive, nothing to do with them) — 200 immediately either way
      // so Resend doesn't keep retrying something that was never going
      // to be actionable.
      if (event.type !== "email.received") return res.status(200).json({ received: true });

      const emailId = event.data.email_id;
      const [already] = await sql`SELECT id FROM support_thread_messages WHERE resend_email_id = ${emailId}`;
      if (already) return res.status(200).json({ received: true, duplicate: true });

      let full;
      try {
        full = await fetchReceivedEmail(emailId);
      } catch (err) {
        // Resend's own delivery guarantees mean it'll retry a non-2xx
        // response — surfacing this as a 502 lets that retry happen
        // instead of silently losing the reply because our follow-up
        // GET for the body happened to fail once.
        return res.status(502).json({ error: "Couldn't fetch the received email: " + (err.message || String(err)) });
      }

      const threadId = extractThreadIdFromHeaders(full.headers);
      const fromEmail = String(full.from || "").replace(/^.*<([^>]+)>.*$/, "$1").trim().toLowerCase();
      const fromName = String(full.from || "").replace(/<.*$/, "").trim().replace(/^"|"$/g, "") || fromEmail;
      const body = (full.text || "").trim() || (full.html || "").replace(/<[^>]+>/g, " ").trim() || "(no message body)";

      if (threadId) {
        const [thread] = await sql`SELECT id FROM support_threads WHERE id = ${threadId}`;
        if (thread) {
          await sql`
            INSERT INTO support_thread_messages (thread_id, sender_type, sender_name, sender_email, body, source, resend_email_id, email_message_id)
            VALUES (${threadId}, 'engineer', ${fromName}, ${fromEmail}, ${body}, 'inbound_email', ${emailId}, ${full.message_id || null})
          `;
          await sql`UPDATE support_threads SET status = 'pending', last_message_at = CURRENT_TIMESTAMP WHERE id = ${threadId}`;
          return res.status(200).json({ received: true, threadId });
        }
      }
      // No thread match — either a cold reply to an address that never
      // had a thread, or the In-Reply-To header didn't survive whatever
      // the sender's email client did to it. Attach it to the engineer
      // it came from if we recognize the address, so it's not lost.
      const [matchedEngineer] = fromEmail ? await sql`SELECT id, display_name, name FROM engineers WHERE email = ${fromEmail}` : [];
      const [newThread] = await sql`
        INSERT INTO support_threads (engineer_id, sender_name, sender_email, subject)
        VALUES (${matchedEngineer ? matchedEngineer.id : null}, ${matchedEngineer ? (matchedEngineer.display_name || matchedEngineer.name) : fromName}, ${fromEmail}, ${String(full.subject || "(no subject)").slice(0, 255)})
        RETURNING id
      `;
      await sql`
        INSERT INTO support_thread_messages (thread_id, sender_type, sender_name, sender_email, body, source, resend_email_id, email_message_id)
        VALUES (${newThread.id}, 'engineer', ${fromName}, ${fromEmail}, ${body}, 'inbound_email', ${emailId}, ${full.message_id || null})
      `;
      return res.status(200).json({ received: true, threadId: newThread.id, newThread: true });
    }

    if (action === "upload-photo") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const kind = req.query.kind === "cover" ? "cover" : "profile";
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("image/")) {
        return res.status(400).json({ error: "Only image uploads are allowed." });
      }
      const body = await readRawBody(req);
      if (!body.length) {
        return res.status(400).json({ error: "No image data received." });
      }
      if (body.length > MAX_PHOTO_BYTES) {
        return res.status(413).json({ error: "Image is too large. Keep it under 10MB." });
      }

      const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      const pathname = `${kind}-photos/${session.id}-${Date.now()}.${ext}`;
      const blob = await put(pathname, body, { access: "public", contentType });

      const column = kind === "cover" ? sql`cover_photo` : sql`profile_photo`;
      const [updated] =
        kind === "cover"
          ? await sql`UPDATE engineers SET cover_photo = ${blob.url}, updated_at = CURRENT_TIMESTAMP WHERE id = ${session.id} RETURNING *`
          : await sql`UPDATE engineers SET profile_photo = ${blob.url}, updated_at = CURRENT_TIMESTAMP WHERE id = ${session.id} RETURNING *`;

      return res.status(200).json({ engineer: privateEngineer(updated), url: blob.url });
    }

    // =========================================================
    // WORK EXPERIENCE
    // =========================================================
    if (action === "work-experience") {
      if (req.method === "GET") {
        const engineerId = Number(req.query.engineerId) || null;
        if (!engineerId) return res.status(400).json({ error: "engineerId is required." });
        const rows = await sql`
          SELECT * FROM work_experience WHERE engineer_id = ${engineerId}
          ORDER BY is_current DESC, start_date DESC NULLS LAST
        `;
        return res.status(200).json({ experience: rows });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const b = req.body || {};
        if (!b.jobTitle || !b.companyName) {
          return res.status(400).json({ error: "Job title and company are required." });
        }
        const [row] = await sql`
          INSERT INTO work_experience (engineer_id, job_title, company_name, start_date, end_date, is_current, description)
          VALUES (${session.id}, ${b.jobTitle}, ${b.companyName}, ${b.startDate || null}, ${b.isCurrent ? null : b.endDate || null}, ${!!b.isCurrent}, ${b.description || null})
          RETURNING *
        `;
        return res.status(201).json({ experience: row });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        const [owned] = await sql`SELECT id FROM work_experience WHERE id = ${id} AND engineer_id = ${session.id}`;
        if (!owned) return res.status(404).json({ error: "Not found." });
        const [row] = await sql`
          UPDATE work_experience
          SET job_title = ${b.jobTitle}, company_name = ${b.companyName},
              start_date = ${b.startDate || null}, end_date = ${b.isCurrent ? null : b.endDate || null},
              is_current = ${!!b.isCurrent}, description = ${b.description || null}
          WHERE id = ${id}
          RETURNING *
        `;
        return res.status(200).json({ experience: row });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM work_experience WHERE id = ${id} AND engineer_id = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // EDUCATION
    // =========================================================
    if (action === "education") {
      if (req.method === "GET") {
        const engineerId = Number(req.query.engineerId) || null;
        if (!engineerId) return res.status(400).json({ error: "engineerId is required." });
        const rows = await sql`
          SELECT * FROM education WHERE engineer_id = ${engineerId}
          ORDER BY end_year DESC NULLS FIRST, start_year DESC NULLS LAST
        `;
        return res.status(200).json({ education: rows });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const b = req.body || {};
        if (!b.institution || !b.degree) {
          return res.status(400).json({ error: "Institution and degree are required." });
        }
        const [row] = await sql`
          INSERT INTO education (engineer_id, institution, degree, field_of_study, start_year, end_year)
          VALUES (${session.id}, ${b.institution}, ${b.degree}, ${b.fieldOfStudy || null}, ${b.startYear || null}, ${b.endYear || null})
          RETURNING *
        `;
        return res.status(201).json({ education: row });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        const [owned] = await sql`SELECT id FROM education WHERE id = ${id} AND engineer_id = ${session.id}`;
        if (!owned) return res.status(404).json({ error: "Not found." });
        const [row] = await sql`
          UPDATE education
          SET institution = ${b.institution}, degree = ${b.degree}, field_of_study = ${b.fieldOfStudy || null},
              start_year = ${b.startYear || null}, end_year = ${b.endYear || null}
          WHERE id = ${id}
          RETURNING *
        `;
        return res.status(200).json({ education: row });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM education WHERE id = ${id} AND engineer_id = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // SKILLS
    // =========================================================
    if (action === "skills") {
      if (req.method === "GET") {
        const engineerId = Number(req.query.engineerId) || null;
        if (!engineerId) return res.status(400).json({ error: "engineerId is required." });
        const rows = await sql`SELECT * FROM skills WHERE engineer_id = ${engineerId} ORDER BY skill_name ASC`;
        return res.status(200).json({ skills: rows });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const name = String((req.body || {}).skillName || "").trim().slice(0, 80);
        if (!name) return res.status(400).json({ error: "Enter a skill name." });
        const [row] = await sql`
          INSERT INTO skills (engineer_id, skill_name) VALUES (${session.id}, ${name})
          ON CONFLICT (engineer_id, skill_name) DO NOTHING
          RETURNING *
        `;
        return res.status(201).json({ skill: row || null });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        const name = String(b.skillName || "").trim().slice(0, 80);
        if (!id || !name) return res.status(400).json({ error: "Enter a skill name." });
        const [dupe] = await sql`SELECT id FROM skills WHERE engineer_id = ${session.id} AND skill_name = ${name} AND id != ${id}`;
        if (dupe) return res.status(409).json({ error: "You already have a skill with that name." });
        const [row] = await sql`
          UPDATE skills SET skill_name = ${name} WHERE id = ${id} AND engineer_id = ${session.id} RETURNING *
        `;
        if (!row) return res.status(404).json({ error: "Skill not found." });
        return res.status(200).json({ skill: row });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM skills WHERE id = ${id} AND engineer_id = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // DIRECTORY
    // =========================================================
    if (action === "directory") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const q = String(req.query.q || "").trim();
      const discipline = String(req.query.discipline || "").trim();
      const sort = req.query.sort === "recent" ? "recent" : "name";
      const limit = Math.min(Number(req.query.limit) || 24, 60);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const like = `%${q}%`;

      const rows = await sql`
        SELECT id, iek_number, display_name, name, discipline, company, title,
               location, profile_photo, last_login,
               COUNT(*) OVER() AS total_count,
               (SELECT status FROM connections WHERE (requester_id = ${session.id} AND addressee_id = engineers.id) OR (requester_id = engineers.id AND addressee_id = ${session.id})) AS conn_status,
               (SELECT requester_id FROM connections WHERE (requester_id = ${session.id} AND addressee_id = engineers.id) OR (requester_id = engineers.id AND addressee_id = ${session.id})) AS conn_requester_id
        FROM engineers
        WHERE (${q}::text = '' OR display_name ILIKE ${like} OR name ILIKE ${like}
               OR company ILIKE ${like} OR iek_number ILIKE ${like} OR title ILIKE ${like})
          AND (${discipline}::text = '' OR discipline = ${discipline})
          AND id != ${session.id}
        ORDER BY ${sort === "recent" ? sql`last_login DESC NULLS LAST` : sql`COALESCE(display_name, name) ASC`}
        LIMIT ${limit} OFFSET ${offset}
      `;

      const disciplines = await sql`
        SELECT DISTINCT discipline FROM engineers WHERE discipline IS NOT NULL ORDER BY discipline
      `;

      return res.status(200).json({
        engineers: rows.map((e) => ({
          id: e.id,
          // No iekNumber here — it's the login username (see the `login`
          // action's PIN check), so the directory must never hand it out.
          displayName: e.display_name || e.name,
          discipline: e.discipline,
          company: e.company,
          title: e.title,
          location: e.location,
          profilePhoto: e.profile_photo,
          verified: true,
          connectionStatus: e.conn_status === "accepted" ? "connected" : e.conn_status === "pending" ? (e.conn_requester_id === session.id ? "pending_outgoing" : "pending_incoming") : "none",
        })),
        total: rows[0]?.total_count ? Number(rows[0].total_count) : 0,
        disciplines: disciplines.map((d) => d.discipline),
      });
    }

    // =========================================================
    // CONNECTIONS
    // =========================================================
    if (action === "connections") {
      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "GET") {
        const accepted = await sql`
          SELECT c.id, c.created_at,
                 CASE WHEN c.requester_id = ${session.id} THEN c.addressee_id ELSE c.requester_id END AS other_id
          FROM connections c
          WHERE c.status = 'accepted' AND (c.requester_id = ${session.id} OR c.addressee_id = ${session.id})
        `;
        const incoming = await sql`
          SELECT c.id, c.created_at, e.id AS other_id, e.display_name, e.name, e.title, e.company, e.profile_photo
          FROM connections c JOIN engineers e ON e.id = c.requester_id
          WHERE c.addressee_id = ${session.id} AND c.status = 'pending'
        `;
        const outgoing = await sql`
          SELECT c.id, c.created_at, e.id AS other_id, e.display_name, e.name, e.title, e.company, e.profile_photo
          FROM connections c JOIN engineers e ON e.id = c.addressee_id
          WHERE c.requester_id = ${session.id} AND c.status = 'pending'
        `;

        let acceptedDetailed = [];
        if (accepted.length) {
          const ids = accepted.map((a) => a.other_id);
          const people = await sql`SELECT id, display_name, name, title, company, profile_photo FROM engineers WHERE id = ANY(${ids})`;
          const byId = Object.fromEntries(people.map((p) => [p.id, p]));
          acceptedDetailed = accepted.map((a) => ({ connectionId: a.id, createdAt: a.created_at, ...byId[a.other_id], displayName: byId[a.other_id]?.display_name || byId[a.other_id]?.name }));
        }

        return res.status(200).json({
          connections: acceptedDetailed,
          incoming: incoming.map((i) => ({ connectionId: i.id, createdAt: i.created_at, id: i.other_id, displayName: i.display_name || i.name, title: i.title, company: i.company, profilePhoto: i.profile_photo })),
          outgoing: outgoing.map((o) => ({ connectionId: o.id, createdAt: o.created_at, id: o.other_id, displayName: o.display_name || o.name, title: o.title, company: o.company, profilePhoto: o.profile_photo })),
        });
      }

      if (req.method === "POST") {
        const addresseeId = Number((req.body || {}).addresseeId);
        if (!addresseeId || addresseeId === session.id) {
          return res.status(400).json({ error: "Invalid recipient." });
        }
        const [existing] = await sql`
          SELECT id, status FROM connections
          WHERE (requester_id = ${session.id} AND addressee_id = ${addresseeId})
             OR (requester_id = ${addresseeId} AND addressee_id = ${session.id})
        `;
        if (existing) {
          return res.status(409).json({ error: existing.status === "accepted" ? "Already connected." : "A request already exists between you two." });
        }
        const [row] = await sql`
          INSERT INTO connections (requester_id, addressee_id, status) VALUES (${session.id}, ${addresseeId}, 'pending') RETURNING *
        `;
        await notify(sql, addresseeId, session.id, "connection_request", "profile", session.id);
        return res.status(201).json({ connection: row });
      }

      if (req.method === "PATCH") {
        const b = req.body || {};
        const id = Number(b.id);
        const status = b.status === "accepted" ? "accepted" : b.status === "declined" ? "declined" : null;
        if (!id || !status) return res.status(400).json({ error: "id and a valid status are required." });
        const [conn] = await sql`SELECT * FROM connections WHERE id = ${id} AND addressee_id = ${session.id} AND status = 'pending'`;
        if (!conn) return res.status(404).json({ error: "Request not found." });
        const [updated] = await sql`UPDATE connections SET status = ${status}, updated_at = CURRENT_TIMESTAMP WHERE id = ${id} RETURNING *`;
        if (status === "accepted") {
          await logActivity(sql, session.id, "connected", `${session.display_name || session.name} connected with another engineer`);
          await notify(sql, conn.requester_id, session.id, "connection_accepted", "profile", session.id);
        }
        return res.status(200).json({ connection: updated });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM connections WHERE id = ${id} AND (requester_id = ${session.id} OR addressee_id = ${session.id})`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, PATCH, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // ACTIVITY FEED
    // =========================================================
    if (action === "feed") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const rows = await sql`
        SELECT a.id, a.action_type, a.description, a.created_at,
               e.id AS engineer_id, e.display_name, e.name, e.profile_photo
        FROM activity_feed a
        JOIN engineers e ON e.id = a.engineer_id
        ORDER BY a.created_at DESC
        LIMIT 40
      `;
      return res.status(200).json({
        activity: rows.map((r) => ({
          id: r.id,
          type: r.action_type,
          description: r.description,
          createdAt: r.created_at,
          engineerId: r.engineer_id,
          displayName: r.display_name || r.name,
          profilePhoto: r.profile_photo,
        })),
      });
    }

    // =========================================================
    // JOBS
    // =========================================================
    if (action === "jobs") {
      if (req.method === "GET" && !req.query.mine) {
        const discipline = String(req.query.discipline || "").trim();
        const jobType = String(req.query.jobType || "").trim();
        const location = String(req.query.location || "").trim();
        const q = String(req.query.q || "").trim();
        const like = `%${q}%`;
        const locLike = `%${location}%`;
        const rows = await sql`
          SELECT j.*, e.display_name AS poster_name, e.name AS poster_registered_name
          FROM jobs j
          LEFT JOIN engineers e ON e.id = j.posted_by
          WHERE j.is_active = TRUE
            AND (${discipline}::text = '' OR j.discipline = ${discipline})
            AND (${jobType}::text = '' OR j.job_type = ${jobType})
            AND (${location}::text = '' OR j.location ILIKE ${locLike})
            AND (${q}::text = '' OR j.title ILIKE ${like} OR j.company_name ILIKE ${like})
          ORDER BY j.created_at DESC
          LIMIT 50
        `;
        return res.status(200).json({ jobs: rows.map(mapJob) });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "GET" && req.query.mine) {
        const rows = await sql`
          SELECT j.*, e.display_name AS poster_name, e.name AS poster_registered_name
          FROM jobs j LEFT JOIN engineers e ON e.id = j.posted_by
          WHERE j.posted_by = ${session.id} ORDER BY j.created_at DESC
        `;
        return res.status(200).json({ jobs: rows.map(mapJob) });
      }

      if (req.method === "POST") {
        const b = req.body || {};
        if (!b.title || !b.companyName || !b.description) {
          return res.status(400).json({ error: "Title, company, and description are required." });
        }
        if (!b.applyUrl && !b.applyEmail) {
          return res.status(400).json({ error: "Add a way to apply — a URL or an email address." });
        }
        const salaryMin = Number(b.salaryMin) || null;
        const salaryMax = Number(b.salaryMax) || null;
        const [row] = await sql`
          INSERT INTO jobs (posted_by, title, company_name, location, job_type, discipline, description, apply_url, apply_email, salary_min, salary_max)
          VALUES (${session.id}, ${b.title}, ${b.companyName}, ${b.location || null}, ${b.jobType || null}, ${b.discipline || null}, ${b.description}, ${b.applyUrl || null}, ${b.applyEmail || null}, ${salaryMin}, ${salaryMax})
          RETURNING *
        `;
        await logActivity(sql, session.id, "job_posted", `${session.display_name || session.name} posted a job: ${b.title} at ${b.companyName}`);
        return res.status(201).json({ job: mapJob({ ...row, poster_name: session.display_name, poster_registered_name: session.name }) });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`UPDATE jobs SET is_active = FALSE WHERE id = ${id} AND posted_by = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // IEK CALENDAR — official events, admin-curated (AGMs, seminars,
    // CPD sessions), broadcast to every member on creation.
    // =========================================================
    if (action === "events") {
      if (req.method === "GET") {
        // Both calendar.html (a member session) and the admin panel's
        // event-management list (an admin session, entirely separate
        // token/table) read this same listing — try the admin token
        // silently first since only requireSession's failure path writes
        // a response, then fall back to it for everyone else.
        const token = getToken(req);
        const [adminSess] = token
          ? await sql`SELECT id FROM admin_sessions WHERE token = ${token} AND expires_at > NOW()`
          : [];
        if (!adminSess) {
          const session = await requireSession(sql, req, res);
          if (!session) return;
        }
        // Upcoming events soonest-first, then past events most-recent-first
        // — two different sort directions depending which side of "now"
        // an event falls on, so it's two CASE-guarded sort keys rather
        // than one plain event_at ASC (which would bury next week's AGM
        // under years of past events sorted oldest-first).
        // event_at is a naive "wall clock" value (the admin's datetime-local
        // input, meant as Nairobi local time, never converted through a JS
        // Date) — TO_CHAR pulls it out as a plain string so it can't get
        // silently reinterpreted in whatever timezone the reading process
        // happens to be running in. A raw Date round-trip here would be a
        // real bug, not just a cosmetic one: it was empirically confirmed
        // to shift the displayed hour by Nairobi's UTC+3 offset depending
        // on the server's local timezone, which is exactly wrong for an
        // AGM start time.
        const rows = await sql`
          SELECT *, (event_at < NOW()) AS is_past, TO_CHAR(event_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS event_at_str
          FROM events
          ORDER BY (event_at < NOW()) ASC,
                   (CASE WHEN event_at >= NOW() THEN event_at END) ASC,
                   (CASE WHEN event_at < NOW() THEN event_at END) DESC
          LIMIT 100
        `;
        return res.status(200).json({
          events: rows.map((e) => ({
            id: e.id,
            title: e.title,
            description: e.description,
            location: e.location,
            eventAt: e.event_at_str,
            imageUrl: e.image_url,
            registerUrl: e.register_url,
            documentUrl: e.document_url,
            isPast: e.is_past,
            createdAt: e.created_at,
          })),
        });
      }

      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;

      if (req.method === "POST") {
        const b = req.body || {};
        if (!b.title || !b.eventAt) {
          return res.status(400).json({ error: "Title and date/time are required." });
        }
        const [row] = await sql`
          WITH inserted AS (
            INSERT INTO events (title, description, location, event_at, image_url, register_url, document_url, created_by_email)
            VALUES (${b.title}, ${b.description || null}, ${b.location || null}, ${b.eventAt}, ${b.imageUrl || null}, ${b.registerUrl || null}, ${b.documentUrl || null}, ${admin.email})
            RETURNING *
          )
          SELECT *, TO_CHAR(event_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS event_at_str FROM inserted
        `;
        // Broadcast to every member in one insert rather than one round
        // trip per recipient — fine at this membership's scale, and
        // avoids notify()'s per-row self-exclusion logic which assumes
        // an engineer actor (this notification has none; actor_id stays
        // NULL, which the notifications GET query LEFT JOINs around).
        await sql`
          INSERT INTO notifications (recipient_id, actor_id, type, target_type, target_id)
          SELECT id, NULL, 'event', 'event', ${row.id} FROM engineers
        `;
        // Email broadcast is best-effort and never blocks the event from
        // being posted — a missing RESEND_API_KEY or a Resend outage
        // shouldn't stop the admin from getting the event onto the
        // Calendar (and its in-app notification) which is the part every
        // member sees regardless of whether they have an email on file.
        try {
          const [tpl] = await sql`SELECT subject, body FROM email_templates WHERE name = 'IEK Event Invitation' AND is_builtin = TRUE`;
          // Admin now explicitly chooses who gets the email — "all
          // engineers with an email" is a deliberate selection, not the
          // silent default it used to be, after the broadcast this
          // action used to fire unconditionally reached everyone with no
          // way to scope a single test send.
          let recipients;
          if (Array.isArray(b.emailRecipientIds) && b.emailRecipientIds.length) {
            const ids = b.emailRecipientIds.map(Number).filter(Boolean);
            recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE id = ANY(${ids}) AND email IS NOT NULL AND email != ''`;
          } else if (b.emailAll) {
            recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE email IS NOT NULL AND email != ''`;
          } else {
            recipients = [];
          }
          if (tpl && recipients.length) {
            const recipientList = recipients.map((r) => ({ id: r.id, name: r.display_name || r.name, email: r.email }));
            const eventDateStr = formatWallClockDate(row.event_at_str);
            // Structured layout (date/time + location card, description,
            // a Register button pointed at the event's real register_url)
            // — see sendEventInviteEmail/renderEventEmailHtml in
            // api/_email.js. The template's own body still supplies the
            // human intro line above that card, so it stays admin-editable.
            const results = await sendEventInviteEmail({
              recipients: recipientList,
              subjectTemplate: tpl.subject,
              introTemplate: tpl.body,
              event: { title: row.title, dateStr: eventDateStr, location: row.location, description: row.description, registerUrl: row.register_url },
            });
            const failed = results.filter((r) => !r.ok);
            const status = failed.length === 0 ? "sent" : failed.length === results.length ? "failed" : "partial";
            await sql`
              INSERT INTO email_logs (sender_admin_email, recipient_ids, recipient_count, failed_count, subject, body, template_name, status, error_summary)
              VALUES (${admin.email}, ${JSON.stringify(recipientList.map((r) => r.id))}, ${results.length}, ${failed.length}, ${tpl.subject.replace("{{event_title}}", row.title)}, ${tpl.body}, 'IEK Event Invitation', ${status},
                      ${failed.length ? failed.slice(0, 5).map((f) => f.email + ": " + f.error).join("; ") : null})
            `;
          }
        } catch (err) {
          await sql`
            INSERT INTO email_logs (sender_admin_email, recipient_count, failed_count, subject, template_name, status, error_summary)
            VALUES (${admin.email}, 0, 0, ${row.title}, 'IEK Event Invitation', 'failed', ${err.message || String(err)})
          `;
        }
        return res.status(201).json({
          event: {
            id: row.id,
            title: row.title,
            description: row.description,
            location: row.location,
            eventAt: row.event_at_str,
            imageUrl: row.image_url,
            registerUrl: row.register_url,
            documentUrl: row.document_url,
          },
        });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM notifications WHERE target_type = 'event' AND target_id = ${id}`;
        await sql`DELETE FROM events WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "upload-event-image") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("image/")) {
        return res.status(400).json({ error: "Only image uploads are allowed." });
      }
      const body = await readRawBody(req);
      if (!body.length) return res.status(400).json({ error: "No file data received." });
      if (body.length > MAX_PHOTO_BYTES) {
        return res.status(413).json({ error: `File is too large. Keep it under ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)}MB.` });
      }
      const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      const blob = await put(`event-images/${Date.now()}.${ext}`, body, { access: "public", contentType });
      return res.status(200).json({ url: blob.url });
    }

    // =========================================================
    // FEED — posts, comments, likes, reposts
    // =========================================================
    if (action === "posts") {
      if (req.method === "GET") {
        const session = await requireSession(sql, req, res);
        if (!session) return;
        const sort = req.query.sort === "top" ? "top" : "recent";
        const limit = Math.min(Number(req.query.limit) || 20, 50);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const authorId = req.query.authorId ? Number(req.query.authorId) : null;
        const savedOnly = req.query.saved === "1";

        const rows = await sql`
          SELECT p.*, e.display_name AS author_display_name, e.name AS author_name, e.title AS author_title,
                 e.company AS author_company, e.profile_photo AS author_photo,
                 (SELECT COUNT(*) FROM comments WHERE post_id = p.id) AS comment_count,
                 (SELECT reaction_type FROM reactions WHERE post_id = p.id AND engineer_id = ${session.id}) AS my_reaction,
                 EXISTS(SELECT 1 FROM saved_posts WHERE post_id = p.id AND engineer_id = ${session.id}) AS is_saved,
                 (SELECT json_object_agg(reaction_type, cnt) FROM (SELECT reaction_type, COUNT(*) AS cnt FROM reactions WHERE post_id = p.id GROUP BY reaction_type) rc) AS reaction_summary,
                 (SELECT COUNT(*) FROM reactions WHERE post_id = p.id) AS reaction_count,
                 orig.id AS orig_id, orig.content AS orig_content, orig.image_url AS orig_image_url, orig.image_urls AS orig_image_urls, orig.video_url AS orig_video_url, orig.created_at AS orig_created_at,
                 oe.display_name AS orig_author_display_name, oe.name AS orig_author_name, oe.profile_photo AS orig_author_photo, orig.author_id AS orig_author_id
          FROM posts p
          JOIN engineers e ON e.id = p.author_id
          LEFT JOIN posts orig ON orig.id = p.reposted_from_id
          LEFT JOIN engineers oe ON oe.id = orig.author_id
          ${savedOnly ? sql`JOIN saved_posts sp ON sp.post_id = p.id AND sp.engineer_id = ${session.id}` : sql``}
          WHERE (${authorId ?? 0}::int = 0 OR p.author_id = ${authorId ?? 0})
          ORDER BY ${authorId ? sql`p.is_pinned DESC,` : sql``} ${sort === "top" ? sql`(SELECT COUNT(*) FROM reactions WHERE post_id = p.id) DESC, p.created_at DESC` : sql`p.created_at DESC`}
          LIMIT ${limit} OFFSET ${offset}
        `;

        return res.status(200).json({
          posts: rows.map((p) => ({
            id: p.id,
            authorId: p.author_id,
            authorName: p.author_display_name || p.author_name,
            authorTitle: p.author_title,
            authorCompany: p.author_company,
            authorPhoto: p.author_photo,
            content: p.content,
            imageUrl: p.image_url,
            imageUrls: p.image_urls && p.image_urls.length ? p.image_urls : null,
            videoUrl: p.video_url,
            createdAt: p.created_at,
            isPinned: p.is_pinned,
            isSaved: p.is_saved,
            commentCount: Number(p.comment_count),
            reactionCount: Number(p.reaction_count),
            reactionSummary: p.reaction_summary || {},
            myReaction: p.my_reaction,
            isMine: p.author_id === session.id,
            repostOf: p.orig_id
              ? {
                  id: p.orig_id,
                  content: p.orig_content,
                  imageUrl: p.orig_image_url,
                  imageUrls: p.orig_image_urls && p.orig_image_urls.length ? p.orig_image_urls : null,
                  videoUrl: p.orig_video_url,
                  createdAt: p.orig_created_at,
                  authorId: p.orig_author_id,
                  authorName: p.orig_author_display_name || p.orig_author_name,
                  authorPhoto: p.orig_author_photo,
                }
              : null,
          })),
        });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const b = req.body || {};
        const content = String(b.content || "").trim().slice(0, 3000);
        const repostedFromId = b.repostedFromId ? Number(b.repostedFromId) : null;
        // imageUrls (plural, from a multi-photo post) and imageUrl (singular,
        // from every older client/repost path) are mutually exclusive — a
        // post with more than one photo doesn't also set the singular column.
        const imageUrls = Array.isArray(b.imageUrls) ? b.imageUrls.filter(Boolean).slice(0, 10) : [];
        const imageUrl = imageUrls.length ? null : b.imageUrl || null;
        if (!content && !imageUrl && !imageUrls.length && !b.videoUrl && !repostedFromId) {
          return res.status(400).json({ error: "Write something, add media, or repost something." });
        }
        const [row] = await sql`
          INSERT INTO posts (author_id, content, image_url, image_urls, video_url, reposted_from_id)
          VALUES (${session.id}, ${content || null}, ${imageUrl}, ${imageUrls.length ? imageUrls : null}, ${b.videoUrl || null}, ${repostedFromId})
          RETURNING *
        `;
        await logActivity(sql, session.id, repostedFromId ? "reposted" : "posted", `${session.display_name || session.name} ${repostedFromId ? "reposted an update" : "shared an update"}`);

        if (repostedFromId) {
          const [orig] = await sql`SELECT author_id FROM posts WHERE id = ${repostedFromId}`;
          if (orig && orig.author_id !== session.id) {
            await notify(sql, orig.author_id, session.id, "repost", "post", repostedFromId);
          }
        }
        return res.status(201).json({ postId: row.id });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM posts WHERE id = ${id} AND author_id = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "upload-post-image" || action === "upload-post-video") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const isVideo = action === "upload-post-video";
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith(isVideo ? "video/" : "image/")) {
        return res.status(400).json({ error: isVideo ? "Only video uploads are allowed." : "Only image uploads are allowed." });
      }
      const body = await readRawBody(req);
      if (!body.length) return res.status(400).json({ error: "No file data received." });
      const cap = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
      if (body.length > cap) return res.status(413).json({ error: `File is too large. Keep it under ${Math.round(cap / 1024 / 1024)}MB.` });
      const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || (isVideo ? "mp4" : "jpg");
      const blob = await put(`${isVideo ? "post-videos" : "post-photos"}/${session.id}-${Date.now()}.${ext}`, body, { access: "public", contentType });
      return res.status(200).json({ url: blob.url });
    }

    if (action === "upload-message-attachment") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const contentType = req.headers["content-type"] || "application/octet-stream";
      // Classified by content-type, not by a client-supplied "type" field
      // — the browser sets this from the actual file/Blob it read, so it
      // can't be spoofed into e.g. claiming a .exe is an "image".
      const attachmentType = contentType.startsWith("image/") ? "image" : contentType.startsWith("audio/") ? "voice" : "file";
      const body = await readRawBody(req);
      if (!body.length) return res.status(400).json({ error: "No file data received." });
      const cap = attachmentType === "image" ? MAX_PHOTO_BYTES : attachmentType === "voice" ? MAX_VOICE_BYTES : MAX_FILE_BYTES;
      if (body.length > cap) return res.status(413).json({ error: `File is too large. Keep it under ${Math.round(cap / 1024 / 1024)}MB.` });

      // The raw body has no filename of its own — the client sends the
      // original name (for real files, e.g. "CV_JaneDoe.pdf") as a query
      // param since it can't ride along in a binary POST body.
      const originalName = String(req.query.filename || "").slice(0, 255);
      const extFromName = originalName.includes(".") ? originalName.split(".").pop().replace(/[^a-z0-9]/gi, "") : "";
      const extFromType = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "");
      const ext = extFromName || extFromType || "bin";
      const folder = attachmentType === "image" ? "message-images" : attachmentType === "voice" ? "message-voice" : "message-files";
      const blob = await put(`${folder}/${session.id}-${Date.now()}.${ext}`, body, { access: "public", contentType });
      return res.status(200).json({ url: blob.url, type: attachmentType, size: body.length, name: originalName || null });
    }

    if (action === "react-post") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const postId = Number((req.body || {}).postId);
      const reactionType = REACTION_TYPES.includes((req.body || {}).reactionType) ? req.body.reactionType : "like";
      if (!postId) return res.status(400).json({ error: "postId is required." });

      const [existing] = await sql`SELECT id, reaction_type FROM reactions WHERE post_id = ${postId} AND engineer_id = ${session.id}`;
      let myReaction;
      if (existing && existing.reaction_type === reactionType) {
        await sql`DELETE FROM reactions WHERE id = ${existing.id}`;
        myReaction = null;
      } else if (existing) {
        await sql`UPDATE reactions SET reaction_type = ${reactionType}, created_at = CURRENT_TIMESTAMP WHERE id = ${existing.id}`;
        myReaction = reactionType;
      } else {
        await sql`INSERT INTO reactions (post_id, engineer_id, reaction_type) VALUES (${postId}, ${session.id}, ${reactionType})`;
        myReaction = reactionType;
        const [post] = await sql`SELECT author_id FROM posts WHERE id = ${postId}`;
        if (post && post.author_id !== session.id) {
          await notify(sql, post.author_id, session.id, "reaction", "post", postId);
        }
      }
      const summaryRows = await sql`SELECT reaction_type, COUNT(*) AS cnt FROM reactions WHERE post_id = ${postId} GROUP BY reaction_type`;
      const reactionSummary = {};
      summaryRows.forEach((r) => { reactionSummary[r.reaction_type] = Number(r.cnt); });
      const reactionCount = summaryRows.reduce((sum, r) => sum + Number(r.cnt), 0);
      return res.status(200).json({ myReaction, reactionCount, reactionSummary });
    }

    if (action === "post-reactors") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const postId = Number(req.query.postId);
      if (!postId) return res.status(400).json({ error: "postId is required." });
      const rows = await sql`
        SELECT r.reaction_type, e.id, e.display_name, e.name, e.profile_photo
        FROM reactions r JOIN engineers e ON e.id = r.engineer_id
        WHERE r.post_id = ${postId} ORDER BY r.created_at DESC LIMIT 100
      `;
      return res.status(200).json({
        reactors: rows.map((r) => ({ id: r.id, displayName: r.display_name || r.name, profilePhoto: r.profile_photo, reactionType: r.reaction_type })),
      });
    }

    if (action === "save-post") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const postId = Number((req.body || {}).postId);
      if (!postId) return res.status(400).json({ error: "postId is required." });
      const [existing] = await sql`SELECT id FROM saved_posts WHERE post_id = ${postId} AND engineer_id = ${session.id}`;
      let saved;
      if (existing) {
        await sql`DELETE FROM saved_posts WHERE id = ${existing.id}`;
        saved = false;
      } else {
        await sql`INSERT INTO saved_posts (post_id, engineer_id) VALUES (${postId}, ${session.id})`;
        saved = true;
      }
      return res.status(200).json({ saved });
    }

    if (action === "pin-post") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const postId = Number((req.body || {}).postId);
      const [post] = await sql`SELECT id, is_pinned FROM posts WHERE id = ${postId} AND author_id = ${session.id}`;
      if (!post) return res.status(404).json({ error: "Post not found." });
      // Only one pinned post per author — unpin any other before pinning this one.
      await sql`UPDATE posts SET is_pinned = FALSE WHERE author_id = ${session.id} AND id != ${postId}`;
      const [updated] = await sql`UPDATE posts SET is_pinned = ${!post.is_pinned} WHERE id = ${postId} RETURNING is_pinned`;
      return res.status(200).json({ isPinned: updated.is_pinned });
    }

    if (action === "report-post") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const postId = Number((req.body || {}).postId);
      const reason = String((req.body || {}).reason || "").trim().slice(0, 500);
      if (!postId) return res.status(400).json({ error: "postId is required." });
      await sql`INSERT INTO post_reports (post_id, reporter_id, reason) VALUES (${postId}, ${session.id}, ${reason || null})`;
      return res.status(201).json({ success: true });
    }

    if (action === "comments") {
      if (req.method === "GET") {
        const session = await requireSession(sql, req, res);
        if (!session) return;
        const postId = Number(req.query.postId);
        if (!postId) return res.status(400).json({ error: "postId is required." });
        const rows = await sql`
          SELECT c.id, c.content, c.created_at, c.author_id, e.display_name, e.name, e.profile_photo
          FROM comments c JOIN engineers e ON e.id = c.author_id
          WHERE c.post_id = ${postId} ORDER BY c.created_at ASC
        `;
        return res.status(200).json({
          comments: rows.map((c) => ({ id: c.id, content: c.content, createdAt: c.created_at, authorId: c.author_id, authorName: c.display_name || c.name, authorPhoto: c.profile_photo, isMine: c.author_id === session.id })),
        });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const b = req.body || {};
        const postId = Number(b.postId);
        const content = String(b.content || "").trim().slice(0, 1000);
        if (!postId || !content) return res.status(400).json({ error: "postId and content are required." });
        const [row] = await sql`INSERT INTO comments (post_id, author_id, content) VALUES (${postId}, ${session.id}, ${content}) RETURNING *`;
        const [post] = await sql`SELECT author_id FROM posts WHERE id = ${postId}`;
        if (post) await notify(sql, post.author_id, session.id, "comment", "post", postId);
        return res.status(201).json({ comment: { id: row.id, content: row.content, createdAt: row.created_at, authorId: session.id, authorName: session.display_name || session.name, authorPhoto: session.profile_photo, isMine: true } });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM comments WHERE id = ${id} AND author_id = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // PROFILE (public view of someone else, or self with ?id=)
    // =========================================================
    if (action === "profile") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const id = Number(req.query.id) || session.id;
      const [target] = id === session.id ? [session] : await sql`SELECT * FROM engineers WHERE id = ${id}`;
      if (!target) return res.status(404).json({ error: "Profile not found." });
      const isSelf = id === session.id;

      // A view only counts when someone else looks at your profile —
      // upsert so re-visiting bumps the timestamp instead of piling up
      // duplicate rows for "who viewed your profile". Awaited rather than
      // fire-and-forget: a serverless function can be frozen/torn down
      // right after its response is sent, which would silently drop an
      // unawaited write before its own HTTP round-trip to the database
      // ever completed — confirmed empirically (a real second-engineer
      // view never showed up in the count without this await).
      if (!isSelf) {
        await sql`
          INSERT INTO profile_views (viewer_id, viewed_id) VALUES (${session.id}, ${id})
          ON CONFLICT (viewer_id, viewed_id) DO UPDATE SET created_at = CURRENT_TIMESTAMP
        `.catch(() => {});
      }

      const [experience, education, skills, connectionRow, connCount, followRow, followersCount, followingCount, viewersRows, viewersCount, presenceRow] = await Promise.all([
        sql`SELECT * FROM work_experience WHERE engineer_id = ${id} ORDER BY is_current DESC, start_date DESC NULLS LAST`,
        sql`SELECT * FROM education WHERE engineer_id = ${id} ORDER BY end_year DESC NULLS FIRST`,
        sql`SELECT * FROM skills WHERE engineer_id = ${id} ORDER BY skill_name ASC`,
        isSelf
          ? Promise.resolve([null])
          : sql`SELECT id, status, requester_id FROM connections WHERE (requester_id = ${session.id} AND addressee_id = ${id}) OR (requester_id = ${id} AND addressee_id = ${session.id})`,
        sql`SELECT COUNT(*) FROM connections WHERE status = 'accepted' AND (requester_id = ${id} OR addressee_id = ${id})`,
        isSelf ? Promise.resolve([null]) : sql`SELECT id FROM follows WHERE follower_id = ${session.id} AND followee_id = ${id}`,
        sql`SELECT COUNT(*) FROM follows WHERE followee_id = ${id}`,
        sql`SELECT COUNT(*) FROM follows WHERE follower_id = ${id}`,
        isSelf
          ? sql`
              SELECT v.created_at, e.id, e.display_name, e.name, e.title, e.company, e.profile_photo
              FROM profile_views v JOIN engineers e ON e.id = v.viewer_id
              WHERE v.viewed_id = ${id} ORDER BY v.created_at DESC LIMIT 20
            `
          : Promise.resolve([]),
        isSelf ? sql`SELECT COUNT(*) FROM profile_views WHERE viewed_id = ${id}` : Promise.resolve([{ count: 0 }]),
        sql`SELECT (last_active > NOW() - INTERVAL '5 minutes') AS is_online, EXTRACT(EPOCH FROM (NOW() - last_active))::int AS seconds_ago FROM engineers WHERE id = ${id}`,
      ]);

      const conn = connectionRow[0];
      const presence = presenceRow[0] || {};

      // The "Experience" detail field is a manually-typed number that's
      // easy to leave at 0/blank even after adding real job history —
      // this gives the frontend a computed-from-history number to fall
      // back to instead of trusting a stale/unset manual figure.
      const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;
      const experienceYearsFromHistory = experience.length
        ? Math.round(
            experience.reduce((sum, x) => {
              if (!x.start_date) return sum;
              const start = new Date(x.start_date);
              const end = x.is_current || !x.end_date ? new Date() : new Date(x.end_date);
              return sum + Math.max(0, (end - start) / MS_PER_YEAR);
            }, 0)
          )
        : null;

      return res.status(200).json({
        engineer: isSelf ? privateEngineer(target) : publicEngineer(target),
        isSelf,
        isOnline: !!presence.is_online,
        lastActiveSecondsAgo: presence.seconds_ago != null ? Number(presence.seconds_ago) : null,
        connectionsCount: Number(connCount[0].count),
        connectionStatus: isSelf ? null : conn ? conn.status : "none",
        connectionId: conn ? conn.id : null,
        isIncomingRequest: conn && conn.status === "pending" && conn.requester_id !== session.id,
        isFollowing: !isSelf && followRow.length > 0,
        followersCount: Number(followersCount[0].count),
        followingCount: Number(followingCount[0].count),
        profileViewsCount: Number(viewersCount[0].count),
        profileViewers: viewersRows.map((v) => ({
          viewedAt: v.created_at,
          id: v.id,
          displayName: v.display_name || v.name,
          title: v.title,
          company: v.company,
          profilePhoto: v.profile_photo,
        })),
        experience,
        education,
        skills,
        experienceYearsFromHistory,
      });
    }

    if (action === "follows") {
      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const followeeId = Number((req.body || {}).followeeId);
        if (!followeeId || followeeId === session.id) return res.status(400).json({ error: "Invalid engineer to follow." });
        await sql`INSERT INTO follows (follower_id, followee_id) VALUES (${session.id}, ${followeeId}) ON CONFLICT DO NOTHING`;
        await notify(sql, followeeId, session.id, "follow", "profile", session.id);
        return res.status(201).json({ following: true });
      }

      if (req.method === "DELETE") {
        const followeeId = Number(req.query.followeeId || (req.body || {}).followeeId);
        if (!followeeId) return res.status(400).json({ error: "followeeId is required." });
        await sql`DELETE FROM follows WHERE follower_id = ${session.id} AND followee_id = ${followeeId}`;
        return res.status(200).json({ following: false });
      }

      if (req.method === "GET") {
        // type=followers -> people who follow the given engineer (default: me)
        // type=following -> people the given engineer follows
        const ofId = Number(req.query.id) || session.id;
        const type = req.query.type === "following" ? "following" : "followers";
        const rows =
          type === "followers"
            ? await sql`
                SELECT e.id, e.display_name, e.name, e.title, e.company, e.profile_photo, f.created_at,
                       EXISTS(SELECT 1 FROM follows WHERE follower_id = ${session.id} AND followee_id = e.id) AS i_follow_them
                FROM follows f JOIN engineers e ON e.id = f.follower_id
                WHERE f.followee_id = ${ofId} ORDER BY f.created_at DESC
              `
            : await sql`
                SELECT e.id, e.display_name, e.name, e.title, e.company, e.profile_photo, f.created_at,
                       EXISTS(SELECT 1 FROM follows WHERE follower_id = ${session.id} AND followee_id = e.id) AS i_follow_them
                FROM follows f JOIN engineers e ON e.id = f.followee_id
                WHERE f.follower_id = ${ofId} ORDER BY f.created_at DESC
              `;
        return res.status(200).json({
          type,
          people: rows.map((r) => ({
            id: r.id,
            displayName: r.display_name || r.name,
            title: r.title,
            company: r.company,
            profilePhoto: r.profile_photo,
            since: r.created_at,
            iFollowThem: r.i_follow_them,
          })),
        });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "toggle-open-to-work") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const [updated] = await sql`
        UPDATE engineers SET open_to_work = NOT open_to_work, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${session.id} RETURNING *
      `;
      return res.status(200).json({ engineer: privateEngineer(updated) });
    }

    // =========================================================
    // MESSAGING — restricted to accepted connections. Polling-based
    // (messages.js re-fetches every 5s while a thread is open), not
    // WebSocket push — true realtime would need pub/sub state shared
    // across serverless instances (e.g. Upstash Redis), which is a
    // lot of added infra for this message volume. Said plainly rather
    // than calling this "real-time" and letting it be discovered.
    // =========================================================
    if (action === "conversations") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const rows = await sql`
        SELECT c.id, c.last_message_at,
               CASE WHEN c.participant1_id = ${session.id} THEN c.participant2_id ELSE c.participant1_id END AS other_id,
               (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_content,
               (SELECT sender_id FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender_id,
               (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = FALSE AND sender_id != ${session.id}) AS unread_count,
               EXISTS(SELECT 1 FROM starred_conversations WHERE engineer_id = ${session.id} AND conversation_id = c.id) AS is_starred
        FROM conversations c
        WHERE c.participant1_id = ${session.id} OR c.participant2_id = ${session.id}
        ORDER BY c.last_message_at DESC NULLS LAST
      `;

      let people = {};
      if (rows.length) {
        const ids = rows.map((r) => r.other_id);
        // Presence is computed entirely in SQL — never send a naive
        // TIMESTAMP-column value for the client to parse into a Date.
        // TIMESTAMP (no timezone) columns get interpreted using
        // whatever timezone the reading process happens to be running
        // in, which is fine on Vercel (UTC) but silently wrong on a
        // dev machine set to a non-UTC zone — exactly the bug class
        // that broke the typing indicator earlier. A plain integer
        // "seconds ago" has no timezone to get wrong.
        const list = await sql`
          SELECT id, display_name, name, title, company, profile_photo,
                 (last_active > NOW() - INTERVAL '5 minutes') AS is_online,
                 EXTRACT(EPOCH FROM (NOW() - last_active))::int AS last_active_seconds_ago
          FROM engineers WHERE id = ANY(${ids})
        `;
        people = Object.fromEntries(list.map((p) => [p.id, p]));
      }

      return res.status(200).json({
        conversations: rows.map((r) => ({
          id: r.id,
          otherId: r.other_id,
          displayName: people[r.other_id]?.display_name || people[r.other_id]?.name || "Unknown",
          title: people[r.other_id]?.title,
          company: people[r.other_id]?.company,
          profilePhoto: people[r.other_id]?.profile_photo,
          lastActiveSecondsAgo: people[r.other_id] ? Number(people[r.other_id].last_active_seconds_ago) : null,
          isOnline: !!people[r.other_id]?.is_online,
          lastMessage: r.last_content,
          lastMessageIsMine: r.last_sender_id === session.id,
          lastMessageAt: r.last_message_at,
          unreadCount: Number(r.unread_count),
          isStarred: r.is_starred,
        })),
        totalUnread: rows.reduce((sum, r) => sum + Number(r.unread_count), 0),
      });
    }

    if (action === "star-conversation") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const conversationId = Number((req.body || {}).conversationId);
      if (!conversationId) return res.status(400).json({ error: "conversationId is required." });
      // Ownership check: only star a conversation you're actually part of.
      const [conv] = await sql`SELECT id FROM conversations WHERE id = ${conversationId} AND (participant1_id = ${session.id} OR participant2_id = ${session.id})`;
      if (!conv) return res.status(404).json({ error: "Conversation not found." });

      const [existing] = await sql`SELECT 1 FROM starred_conversations WHERE engineer_id = ${session.id} AND conversation_id = ${conversationId}`;
      if (existing) {
        await sql`DELETE FROM starred_conversations WHERE engineer_id = ${session.id} AND conversation_id = ${conversationId}`;
        return res.status(200).json({ isStarred: false });
      }
      await sql`INSERT INTO starred_conversations (engineer_id, conversation_id) VALUES (${session.id}, ${conversationId})`;
      return res.status(200).json({ isStarred: true });
    }

    if (action === "messages") {
      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "GET") {
        const otherId = Number(req.query.with);
        if (!otherId) return res.status(400).json({ error: "with= (the other engineer's id) is required." });

        const lo = Math.min(session.id, otherId);
        const hi = Math.max(session.id, otherId);
        const [conv] = await sql`
          SELECT * FROM conversations WHERE participant1_id = ${lo} AND participant2_id = ${hi}
        `;
        if (!conv) return res.status(200).json({ conversationId: null, messages: [] });

        const messages = await sql`
          SELECT id, sender_id, content, is_read, created_at, edited_at,
                 attachment_url, attachment_type, attachment_name, attachment_size, attachment_duration
          FROM messages
          WHERE conversation_id = ${conv.id} ORDER BY created_at ASC LIMIT 200
        `;
        // Awaited for the same reason as the profile-view and last-active
        // writes above — an unawaited write in a serverless function isn't
        // guaranteed to finish before the function is torn down, which
        // would silently undermine the read-receipt feature.
        await sql`UPDATE messages SET is_read = TRUE WHERE conversation_id = ${conv.id} AND sender_id != ${session.id} AND is_read = FALSE`.catch(() => {});

        return res.status(200).json({
          conversationId: conv.id,
          messages: messages.map((m) => ({
            id: m.id,
            senderId: m.sender_id,
            content: m.content,
            isRead: m.is_read,
            createdAt: m.created_at,
            isEdited: !!m.edited_at,
            isMine: m.sender_id === session.id,
            attachmentUrl: m.attachment_url,
            attachmentType: m.attachment_type,
            attachmentName: m.attachment_name,
            attachmentSize: m.attachment_size,
            attachmentDuration: m.attachment_duration,
          })),
        });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        const content = String(b.content || "").trim().slice(0, 4000);
        if (!id || !content) return res.status(400).json({ error: "Message content can't be empty." });
        const [updated] = await sql`
          UPDATE messages SET content = ${content}, edited_at = CURRENT_TIMESTAMP
          WHERE id = ${id} AND sender_id = ${session.id}
          RETURNING id, sender_id, content, is_read, created_at, edited_at
        `;
        if (!updated) return res.status(404).json({ error: "Message not found." });
        return res.status(200).json({
          message: { id: updated.id, senderId: updated.sender_id, content: updated.content, isRead: updated.is_read, createdAt: updated.created_at, isEdited: true, isMine: true },
        });
      }

      if (req.method === "POST") {
        const b = req.body || {};
        const otherId = Number(b.recipientId);
        const content = String(b.content || "").trim().slice(0, 4000);
        const attachmentType = ["image", "file", "voice"].includes(b.attachmentType) ? b.attachmentType : null;
        const attachmentUrl = attachmentType ? String(b.attachmentUrl || "") : null;
        if (!otherId || otherId === session.id) return res.status(400).json({ error: "Invalid recipient." });
        if (!content && !attachmentUrl) return res.status(400).json({ error: "Message can't be empty." });
        if (attachmentType && !attachmentUrl) return res.status(400).json({ error: "Attachment upload URL is missing." });

        const [conn] = await sql`
          SELECT id FROM connections
          WHERE status = 'accepted'
            AND ((requester_id = ${session.id} AND addressee_id = ${otherId}) OR (requester_id = ${otherId} AND addressee_id = ${session.id}))
        `;
        if (!conn) return res.status(403).json({ error: "You can only message engineers you're connected with." });

        const lo = Math.min(session.id, otherId);
        const hi = Math.max(session.id, otherId);
        const [conv] = await sql`
          INSERT INTO conversations (participant1_id, participant2_id, last_message_at)
          VALUES (${lo}, ${hi}, CURRENT_TIMESTAMP)
          ON CONFLICT (participant1_id, participant2_id) DO UPDATE SET last_message_at = CURRENT_TIMESTAMP
          RETURNING *
        `;
        const [message] = await sql`
          INSERT INTO messages (conversation_id, sender_id, content, attachment_url, attachment_type, attachment_name, attachment_size, attachment_duration)
          VALUES (
            ${conv.id}, ${session.id}, ${content || null},
            ${attachmentUrl}, ${attachmentType},
            ${attachmentType ? String(b.attachmentName || "").slice(0, 255) || null : null},
            ${attachmentType ? Number(b.attachmentSize) || null : null},
            ${attachmentType === "voice" ? Number(b.attachmentDuration) || null : null}
          )
          RETURNING *
        `;
        // Sending clears "typing" — otherwise the indicator can linger
        // up to TYPING_WINDOW_MS after the message already arrived.
        await sql`UPDATE conversations SET typing_by = NULL, typing_until = NULL WHERE id = ${conv.id}`;
        await notify(sql, otherId, session.id, "message", "conversation", conv.id);
        return res.status(201).json({
          conversationId: conv.id,
          message: {
            id: message.id, senderId: message.sender_id, content: message.content, isRead: message.is_read,
            createdAt: message.created_at, isEdited: false, isMine: true,
            attachmentUrl: message.attachment_url, attachmentType: message.attachment_type,
            attachmentName: message.attachment_name, attachmentSize: message.attachment_size, attachmentDuration: message.attachment_duration,
          },
        });
      }

      res.setHeader("Allow", "GET, POST, PUT, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // Polled separately (not folded into GET messages) so the client can
    // check "is the other person typing" every 2s without re-fetching
    // the whole thread that often.
    if (action === "typing") {
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const otherId = Number(req.query.with || (req.body || {}).withId);
      if (!otherId) return res.status(400).json({ error: "with/withId is required." });
      const lo = Math.min(session.id, otherId);
      const hi = Math.max(session.id, otherId);

      if (req.method === "GET") {
        const [conv] = await sql`
          SELECT (typing_by = ${otherId} AND typing_until > NOW()) AS is_typing
          FROM conversations WHERE participant1_id = ${lo} AND participant2_id = ${hi}
        `;
        return res.status(200).json({ isTyping: !!(conv && conv.is_typing) });
      }

      if (req.method === "POST") {
        await sql`
          INSERT INTO conversations (participant1_id, participant2_id, typing_by, typing_until)
          VALUES (${lo}, ${hi}, ${session.id}, NOW() + (${TYPING_WINDOW_MS}::int * INTERVAL '1 millisecond'))
          ON CONFLICT (participant1_id, participant2_id) DO UPDATE SET typing_by = ${session.id}, typing_until = NOW() + (${TYPING_WINDOW_MS}::int * INTERVAL '1 millisecond')
        `;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // NOTIFICATIONS
    // =========================================================
    if (action === "notifications") {
      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "GET") {
        // actor_id is NULL for broadcast/system notifications (e.g. a new
        // IEK Calendar event isn't "posted by" a fellow engineer) — LEFT
        // JOIN so those rows survive instead of silently vanishing.
        const rows = await sql`
          SELECT n.id, n.type, n.target_type, n.target_id, n.is_read, n.created_at,
                 a.id AS actor_id, a.display_name, a.name, a.profile_photo,
                 ev.title AS event_title,
                 el.title AS election_title,
                 cp.position AS campaign_position
          FROM notifications n
          LEFT JOIN engineers a ON a.id = n.actor_id
          LEFT JOIN events ev ON ev.id = n.target_id AND n.target_type = 'event'
          LEFT JOIN elections el ON el.id = n.target_id AND n.target_type = 'election'
          LEFT JOIN campaigns cp ON cp.id = n.target_id AND n.target_type = 'campaign'
          WHERE n.recipient_id = ${session.id}
          ORDER BY n.created_at DESC
          LIMIT 100
        `;

        // Group consecutive same (type, target) notifications — "5 people
        // liked your post" instead of 5 separate lines — same idea as
        // LinkedIn's grouping, simple version: group everything sharing
        // a type+target regardless of exact timestamp, since a single
        // post/comment thread realistically only accumulates reactions
        // over a short window anyway.
        const groups = new Map();
        const order = [];
        for (const r of rows) {
          const key = r.type + ":" + r.target_type + ":" + r.target_id;
          if (!groups.has(key)) {
            groups.set(key, { ...r, actorNames: [], actorPhotos: [], isReadAll: true, latestCreatedAt: r.created_at });
            order.push(key);
          }
          const g = groups.get(key);
          g.actorNames.push(r.display_name || r.name);
          g.actorPhotos.push(r.profile_photo);
          if (!r.is_read) g.isReadAll = false;
          if (new Date(r.created_at) > new Date(g.latestCreatedAt)) g.latestCreatedAt = r.created_at;
        }

        const verb = { reaction: "reacted to your post", comment: "commented on your post", repost: "reposted your post", connection_request: "sent you a connection request", connection_accepted: "accepted your connection request", message: "sent you a message", follow: "started following you" };

        const notifications = order.map((key) => {
          const g = groups.get(key);
          // Broadcast/system notifications (no actor engineer) get their
          // own text built from the event itself, not the "X and Y did
          // something" actor-name template the rest of these use.
          const systemText = {
            event: () => "New IEK Calendar event: " + (g.event_title || "View details"),
            election_created: () => "New election: " + (g.election_title || "View details") + " — nominations are open",
            election_open: () => "Voting is now open: " + (g.election_title || "Cast your vote"),
            election_results: () => "Results announced: " + (g.election_title || "See the results"),
            campaign_verified: () => "Your campaign for " + (g.campaign_position || "office") + " has been verified — you're on the ballot",
          }[g.type];
          if (systemText) {
            return {
              id: g.id,
              type: g.type,
              targetType: g.target_type,
              targetId: g.target_id,
              isRead: g.isReadAll,
              createdAt: g.latestCreatedAt,
              actorId: null,
              actorPhoto: null,
              count: 1,
              text: systemText(),
            };
          }
          const names = g.actorNames;
          let who;
          if (names.length === 1) who = names[0];
          else if (names.length === 2) who = names[0] + " and " + names[1];
          else who = names[0] + " and " + (names.length - 1) + " others";
          return {
            id: g.id,
            type: g.type,
            targetType: g.target_type,
            targetId: g.target_id,
            isRead: g.isReadAll,
            createdAt: g.latestCreatedAt,
            actorId: g.actor_id,
            actorPhoto: g.actorPhotos[0],
            count: names.length,
            text: who + " " + (verb[g.type] || "did something"),
          };
        });

        const [unread] = await sql`SELECT COUNT(*) FROM notifications WHERE recipient_id = ${session.id} AND is_read = FALSE`;
        return res.status(200).json({ notifications, unreadCount: Number(unread.count) });
      }

      if (req.method === "POST") {
        const b = req.body || {};
        if (b.markAll) {
          await sql`UPDATE notifications SET is_read = TRUE WHERE recipient_id = ${session.id}`;
        } else if (b.type && b.targetType && b.targetId) {
          // Marking one grouped notification as read marks the whole group.
          await sql`UPDATE notifications SET is_read = TRUE WHERE recipient_id = ${session.id} AND type = ${b.type} AND target_type = ${b.targetType} AND target_id = ${Number(b.targetId)}`;
        } else if (b.id) {
          await sql`UPDATE notifications SET is_read = TRUE WHERE id = ${Number(b.id)} AND recipient_id = ${session.id}`;
        }
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // DASHBOARD (aggregate: stats + suggestions + recent activity)
    // =========================================================
    if (action === "dashboard") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const [expCount, eduCount, skillCount, connCount, pendingCount, viewsCount, suggestions, recent] = await Promise.all([
        sql`SELECT COUNT(*) FROM work_experience WHERE engineer_id = ${session.id}`,
        sql`SELECT COUNT(*) FROM education WHERE engineer_id = ${session.id}`,
        sql`SELECT COUNT(*) FROM skills WHERE engineer_id = ${session.id}`,
        sql`SELECT COUNT(*) FROM connections WHERE status = 'accepted' AND (requester_id = ${session.id} OR addressee_id = ${session.id})`,
        sql`SELECT COUNT(*) FROM connections WHERE addressee_id = ${session.id} AND status = 'pending'`,
        sql`SELECT COUNT(*) FROM profile_views WHERE viewed_id = ${session.id}`,
        sql`
          SELECT id, display_name, name, title, company, discipline, profile_photo
          FROM engineers
          WHERE id != ${session.id}
            AND id NOT IN (
              SELECT CASE WHEN requester_id = ${session.id} THEN addressee_id ELSE requester_id END
              FROM connections WHERE requester_id = ${session.id} OR addressee_id = ${session.id}
            )
          ORDER BY (discipline = ${session.discipline}) DESC, last_login DESC NULLS LAST
          LIMIT 4
        `,
        sql`
          SELECT a.id, a.action_type, a.description, a.created_at, e.display_name, e.name, e.profile_photo
          FROM activity_feed a JOIN engineers e ON e.id = a.engineer_id
          ORDER BY a.created_at DESC LIMIT 5
        `,
      ]);

      const completion = computeProfileCompletion(session, {
        experience: Number(expCount[0].count),
        education: Number(eduCount[0].count),
        skills: Number(skillCount[0].count),
      });

      return res.status(200).json({
        engineer: privateEngineer(session),
        profileCompletion: completion.percent,
        profileMissing: completion.missing,
        connectionsCount: Number(connCount[0].count),
        pendingRequestsCount: Number(pendingCount[0].count),
        profileViewsCount: Number(viewsCount[0].count),
        suggestions: suggestions.map((s) => ({
          id: s.id,
          displayName: s.display_name || s.name,
          title: s.title,
          company: s.company,
          discipline: s.discipline,
          profilePhoto: s.profile_photo,
        })),
        recentActivity: recent.map((r) => ({
          id: r.id,
          type: r.action_type,
          description: r.description,
          createdAt: r.created_at,
          displayName: r.display_name || r.name,
          profilePhoto: r.profile_photo,
        })),
      });
    }

    // =========================================================
    // ADMIN PANEL — engineer onboarding/roster management. Entirely
    // separate auth (admin_sessions + email/PIN allowlist), not tied to
    // the engineers table, not linked from anywhere a regular member
    // would see (admin-login.html isn't referenced in the public nav).
    // =========================================================
    if (action === "admin-login") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const { email, pin } = req.body || {};
      const normEmail = String(email || "").trim().toLowerCase();
      if (!ADMIN_EMAILS.includes(normEmail) || String(pin || "") !== ADMIN_PIN) {
        return res.status(401).json({ error: "Invalid email or PIN." });
      }
      const token = randomBytes(32).toString("hex");
      await sql`INSERT INTO admin_sessions (token, email, expires_at) VALUES (${token}, ${normEmail}, NOW() + (${ADMIN_SESSION_DAYS}::int * INTERVAL '1 day'))`;
      return res.status(200).json({ token, email: normEmail });
    }

    if (action === "admin-logout") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const token = getToken(req);
      if (token) await sql`DELETE FROM admin_sessions WHERE token = ${token}`;
      return res.status(200).json({ success: true });
    }

    if (action === "admin-me") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      return res.status(200).json({ email: admin.email });
    }

    if (action === "admin-engineers") {
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;

      if (req.method === "GET") {
        const q = String(req.query.q || "").trim();
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const like = `%${q}%`;
        const [rows, totalRow, activeRow] = await Promise.all([
          sql`
            SELECT id, iek_number, name, display_name, last_login, last_active, created_at,
                   consent_data_at, consent_marketing,
                   (last_active > NOW() - INTERVAL '5 minutes') AS is_active_now
            FROM engineers
            WHERE (${q}::text = '' OR name ILIKE ${like} OR display_name ILIKE ${like} OR iek_number ILIKE ${like})
            ORDER BY last_active DESC NULLS LAST, id DESC
            LIMIT ${limit} OFFSET ${offset}
          `,
          sql`SELECT COUNT(*) FROM engineers`,
          sql`SELECT COUNT(*) FROM engineers WHERE last_active > NOW() - INTERVAL '5 minutes'`,
        ]);
        return res.status(200).json({
          engineers: rows.map((e) => ({
            id: e.id,
            iekNumber: e.iek_number,
            name: e.name,
            displayName: e.display_name || e.name,
            lastLogin: e.last_login,
            lastActive: e.last_active,
            createdAt: e.created_at,
            isActiveNow: e.is_active_now,
            consentDataAt: e.consent_data_at,
            consentMarketing: !!e.consent_marketing,
          })),
          total: Number(totalRow[0].count),
          activeNow: Number(activeRow[0].count),
        });
      }

      if (req.method === "POST") {
        const b = req.body || {};
        const name = String(b.name || "").trim();
        const iekNumber = String(b.iekNumber || "").trim();
        if (!name || !iekNumber) {
          return res.status(400).json({ error: "Name and membership number are required." });
        }
        const digits = digitsOnly(iekNumber);
        if (!digits) return res.status(400).json({ error: "Membership number must contain digits." });
        const [collision] = await sql`SELECT id FROM engineers WHERE regexp_replace(iek_number, '[^0-9]', '', 'g') = ${digits}`;
        if (collision) return res.status(409).json({ error: "An engineer with that membership number already exists." });
        const [created] = await sql`
          INSERT INTO engineers (iek_number, name) VALUES (${iekNumber}, ${name})
          RETURNING id, iek_number, name, display_name
        `;
        return res.status(201).json({
          engineer: { id: created.id, iekNumber: created.iek_number, name: created.name, displayName: created.display_name || created.name },
        });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        const name = String(b.name || "").trim();
        const iekNumber = String(b.iekNumber || "").trim();
        if (!id || !name || !iekNumber) {
          return res.status(400).json({ error: "Name and membership number are required." });
        }
        const digits = digitsOnly(iekNumber);
        if (!digits) return res.status(400).json({ error: "Membership number must contain digits." });
        const [collision] = await sql`
          SELECT id FROM engineers WHERE regexp_replace(iek_number, '[^0-9]', '', 'g') = ${digits} AND id != ${id}
        `;
        if (collision) return res.status(409).json({ error: "Another engineer already has that membership number." });
        const [updated] = await sql`
          UPDATE engineers SET name = ${name}, iek_number = ${iekNumber} WHERE id = ${id}
          RETURNING id, iek_number, name, display_name
        `;
        if (!updated) return res.status(404).json({ error: "Engineer not found." });
        return res.status(200).json({
          engineer: { id: updated.id, iekNumber: updated.iek_number, name: updated.name, displayName: updated.display_name || updated.name },
        });
      }

      res.setHeader("Allow", "GET, POST, PUT, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    // =========================================================
    // ADMIN EMAIL — bulk sends from NES@engineerhuub.com via Resend
    // (api/_email.js), template library, and a send history. See also
    // the `save-email`/`support` actions above (the engineer-facing
    // half of this system).
    // =========================================================
    if (action === "admin-email-recipients") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      const [rows, disciplines, companies] = await Promise.all([
        sql`SELECT id, display_name, name, email, discipline, company, consent_marketing FROM engineers WHERE email IS NOT NULL AND email != '' ORDER BY display_name NULLS LAST, name`,
        sql`SELECT DISTINCT discipline FROM engineers WHERE discipline IS NOT NULL AND email IS NOT NULL AND email != '' ORDER BY discipline`,
        sql`SELECT DISTINCT company FROM engineers WHERE company IS NOT NULL AND email IS NOT NULL AND email != '' ORDER BY company`,
      ]);
      return res.status(200).json({
        engineers: rows.map((e) => ({ id: e.id, name: e.display_name || e.name, email: e.email, discipline: e.discipline, company: e.company, consentMarketing: !!e.consent_marketing })),
        disciplines: disciplines.map((d) => d.discipline),
        companies: companies.map((c) => c.company),
        marketingConsentCount: rows.filter((e) => e.consent_marketing).length,
      });
    }

    if (action === "admin-send-email") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      const b = req.body || {};
      const subject = String(b.subject || "").trim().slice(0, 255);
      const body = String(b.body || "").trim().slice(0, 20000);
      if (!subject || !body) return res.status(400).json({ error: "Add a subject and a message." });

      // Broadcast-style targeting (all / by discipline / by company)
      // respects the marketing opt-in captured at signup and editable in
      // Settings (see migrations/013_consent.sql) — this tool exists to
      // send exactly the kind of content that consent describes ("jobs,
      // internships, training, mentorship..."). Picking specific people
      // by name is left unfiltered: an admin explicitly addressing one
      // person is a direct communication, not the broadcast that opt-in
      // was ever meant to gate.
      let recipients;
      if (Array.isArray(b.recipientIds) && b.recipientIds.length) {
        const ids = b.recipientIds.map(Number).filter(Boolean);
        recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE id = ANY(${ids}) AND email IS NOT NULL AND email != ''`;
      } else if (b.filterDiscipline) {
        recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE discipline = ${b.filterDiscipline} AND consent_marketing = TRUE AND email IS NOT NULL AND email != ''`;
      } else if (b.filterCompany) {
        recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE company = ${b.filterCompany} AND consent_marketing = TRUE AND email IS NOT NULL AND email != ''`;
      } else if (b.all) {
        recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE consent_marketing = TRUE AND email IS NOT NULL AND email != ''`;
      } else {
        return res.status(400).json({ error: "Choose at least one recipient." });
      }
      if (!recipients.length) return res.status(400).json({ error: "No matching engineers have an email address on file." });
      if (recipients.length > 1000) return res.status(400).json({ error: "That's more than 1000 recipients in one send — narrow the filter." });

      const recipientList = recipients.map((r) => ({ id: r.id, name: r.display_name || r.name, email: r.email }));
      let results;
      let topLevelError = null;
      try {
        results = await sendBulkEmail({
          recipients: recipientList, subject, body,
          ctaLabel: "Open Engineer Hub", ctaUrl: "https://www.engineerhuub.com/dashboard.html",
        });
      } catch (err) {
        topLevelError = err.message || String(err);
        results = recipientList.map((r) => ({ engineerId: r.id, email: r.email, ok: false, error: topLevelError }));
      }
      const failed = results.filter((r) => !r.ok);
      const status = failed.length === 0 ? "sent" : failed.length === results.length ? "failed" : "partial";
      await sql`
        INSERT INTO email_logs (sender_admin_email, recipient_ids, recipient_count, failed_count, subject, body, template_name, status, error_summary)
        VALUES (${admin.email}, ${JSON.stringify(recipientList.map((r) => r.id))}, ${results.length}, ${failed.length}, ${subject}, ${body}, ${b.templateName || null}, ${status},
                ${topLevelError || (failed.length ? failed.slice(0, 5).map((f) => f.email + ": " + f.error).join("; ") : null)})
      `;
      if (topLevelError) return res.status(502).json({ error: "Couldn't send: " + topLevelError, sentCount: 0, failedCount: results.length });
      return res.status(200).json({ sentCount: results.length - failed.length, failedCount: failed.length, status });
    }

    // Manually (re-)send the event-invitation email for an existing
    // event — same structured layout/content as the automatic send on
    // creation (sendEventInviteEmail), just triggered from the event
    // list instead of firing once at creation time. Not consent-filtered
    // in "all" mode, matching the auto-send: this is the same official
    // IEK Calendar content either way, not the marketing broadcasts the
    // generic admin-send-email tool sends.
    if (action === "admin-send-event-email") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      const b = req.body || {};
      const eventId = Number(b.eventId);
      const subject = String(b.subject || "").trim().slice(0, 255);
      const body = String(b.body || "").trim().slice(0, 20000);
      if (!eventId || !subject || !body) return res.status(400).json({ error: "Add a subject and a message." });

      const [event] = await sql`
        SELECT *, TO_CHAR(event_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS event_at_str FROM events WHERE id = ${eventId}
      `;
      if (!event) return res.status(404).json({ error: "Event not found." });

      let recipients;
      if (Array.isArray(b.emailRecipientIds) && b.emailRecipientIds.length) {
        const ids = b.emailRecipientIds.map(Number).filter(Boolean);
        recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE id = ANY(${ids}) AND email IS NOT NULL AND email != ''`;
      } else if (b.emailAll) {
        recipients = await sql`SELECT id, display_name, name, email FROM engineers WHERE email IS NOT NULL AND email != ''`;
      } else {
        return res.status(400).json({ error: "Choose at least one recipient." });
      }
      if (!recipients.length) return res.status(400).json({ error: "No matching engineers have an email address on file." });
      if (recipients.length > 1000) return res.status(400).json({ error: "That's more than 1000 recipients in one send — narrow the selection." });

      const recipientList = recipients.map((r) => ({ id: r.id, name: r.display_name || r.name, email: r.email }));
      const eventDateStr = formatWallClockDate(event.event_at_str);
      let results;
      let topLevelError = null;
      try {
        results = await sendEventInviteEmail({
          recipients: recipientList,
          subjectTemplate: subject,
          introTemplate: body,
          event: { title: event.title, dateStr: eventDateStr, location: event.location, description: event.description, registerUrl: event.register_url },
        });
      } catch (err) {
        topLevelError = err.message || String(err);
        results = recipientList.map((r) => ({ engineerId: r.id, email: r.email, ok: false, error: topLevelError }));
      }
      const failed = results.filter((r) => !r.ok);
      const status = failed.length === 0 ? "sent" : failed.length === results.length ? "failed" : "partial";
      await sql`
        INSERT INTO email_logs (sender_admin_email, recipient_ids, recipient_count, failed_count, subject, body, template_name, status, error_summary)
        VALUES (${admin.email}, ${JSON.stringify(recipientList.map((r) => r.id))}, ${results.length}, ${failed.length}, ${subject}, ${body}, 'IEK Event Invitation', ${status},
                ${topLevelError || (failed.length ? failed.slice(0, 5).map((f) => f.email + ": " + f.error).join("; ") : null)})
      `;
      if (topLevelError) return res.status(502).json({ error: "Couldn't send: " + topLevelError, sentCount: 0, failedCount: results.length });
      return res.status(200).json({ sentCount: results.length - failed.length, failedCount: failed.length, status });
    }

    if (action === "admin-email-logs") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rows = await sql`
        SELECT id, sender_admin_email, recipient_count, failed_count, subject, template_name, status, error_summary, sent_at
        FROM email_logs ORDER BY sent_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
      return res.status(200).json({
        logs: rows.map((l) => ({
          id: l.id, senderAdminEmail: l.sender_admin_email, recipientCount: l.recipient_count, failedCount: l.failed_count,
          subject: l.subject, templateName: l.template_name, status: l.status, errorSummary: l.error_summary, sentAt: l.sent_at,
        })),
      });
    }

    if (action === "admin-email-templates") {
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;

      if (req.method === "GET") {
        const rows = await sql`SELECT id, name, subject, body, is_builtin, created_at FROM email_templates ORDER BY is_builtin DESC, created_at`;
        return res.status(200).json({
          templates: rows.map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, isBuiltin: t.is_builtin, createdAt: t.created_at })),
        });
      }
      if (req.method === "POST") {
        const b = req.body || {};
        const name = String(b.name || "").trim().slice(0, 100);
        const subject = String(b.subject || "").trim().slice(0, 255);
        const body = String(b.body || "").trim().slice(0, 20000);
        if (!name || !subject || !body) return res.status(400).json({ error: "Add a name, subject, and message body." });
        if (b.id) {
          const [existing] = await sql`SELECT is_builtin FROM email_templates WHERE id = ${Number(b.id)}`;
          if (!existing) return res.status(404).json({ error: "Template not found." });
          if (existing.is_builtin) return res.status(400).json({ error: "Built-in templates can't be edited — save your changes as a new template instead." });
          const [updated] = await sql`UPDATE email_templates SET name = ${name}, subject = ${subject}, body = ${body} WHERE id = ${Number(b.id)} RETURNING *`;
          return res.status(200).json({ template: { id: updated.id, name: updated.name, subject: updated.subject, body: updated.body, isBuiltin: updated.is_builtin } });
        }
        const [created] = await sql`INSERT INTO email_templates (name, subject, body, is_builtin) VALUES (${name}, ${subject}, ${body}, FALSE) RETURNING *`;
        return res.status(201).json({ template: { id: created.id, name: created.name, subject: created.subject, body: created.body, isBuiltin: created.is_builtin } });
      }
      if (req.method === "DELETE") {
        const id = Number(req.query.id);
        if (!id) return res.status(400).json({ error: "Missing template id." });
        const [existing] = await sql`SELECT is_builtin FROM email_templates WHERE id = ${id}`;
        if (!existing) return res.status(404).json({ error: "Template not found." });
        if (existing.is_builtin) return res.status(400).json({ error: "Built-in templates can't be deleted." });
        await sql`DELETE FROM email_templates WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }
      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "admin-support") {
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;

      if (req.method === "GET") {
        const status = String(req.query.status || "").trim();
        const threads = await sql`
          SELECT t.*, e.iek_number
          FROM support_threads t LEFT JOIN engineers e ON e.id = t.engineer_id
          WHERE (${status}::text = '' OR t.status = ${status})
          ORDER BY (t.status = 'pending') DESC, t.last_message_at DESC
        `;
        if (!threads.length) return res.status(200).json({ threads: [] });
        const ids = threads.map((t) => t.id);
        const messages = await sql`
          SELECT thread_id, sender_type, sender_name, sender_email, body, source, created_at
          FROM support_thread_messages WHERE thread_id = ANY(${ids}) ORDER BY created_at ASC
        `;
        return res.status(200).json({
          threads: threads.map((t) => ({
            id: t.id, subject: t.subject, status: t.status, createdAt: t.created_at, lastMessageAt: t.last_message_at,
            sender: { id: t.engineer_id, name: t.sender_name, email: t.sender_email, iekNumber: t.iek_number },
            messages: messages.filter((m) => m.thread_id === t.id).map((m) => ({
              senderType: m.sender_type, senderName: m.sender_name, senderEmail: m.sender_email,
              body: m.body, source: m.source, createdAt: m.created_at,
            })),
          })),
        });
      }
      res.setHeader("Allow", "GET, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "admin-support-reply") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;
      const b = req.body || {};
      const threadId = Number(b.id);
      const reply = String(b.reply || "").trim().slice(0, 5000);
      if (!threadId || !reply) return res.status(400).json({ error: "Write a reply." });
      const [thread] = await sql`SELECT * FROM support_threads WHERE id = ${threadId}`;
      if (!thread) return res.status(404).json({ error: "Support thread not found." });

      const [msgRow] = await sql`
        INSERT INTO support_thread_messages (thread_id, sender_type, sender_name, sender_email, body)
        VALUES (${threadId}, 'admin', ${admin.email}, ${admin.email}, ${reply})
        RETURNING id
      `;
      await sql`UPDATE support_threads SET status = 'resolved', last_message_at = CURRENT_TIMESTAMP WHERE id = ${threadId}`;

      // Best-effort — a thread with no email on file (an in-app-only
      // conversation), or a Resend hiccup, shouldn't stop the reply from
      // saving; the engineer still sees it next time they open Support.
      if (thread.sender_email) {
        try {
          // Threading this under the most recent inbound message we have
          // (if any) so it lands in the same conversation in the
          // recipient's own email client, not as a disconnected new email.
          const [lastInbound] = await sql`
            SELECT email_message_id FROM support_thread_messages
            WHERE thread_id = ${threadId} AND source = 'inbound_email' AND email_message_id IS NOT NULL
            ORDER BY created_at DESC LIMIT 1
          `;
          const { resendEmailId, outboundMessageId } = await sendThreadEmail({
            to: thread.sender_email,
            subject: (thread.subject || "").toLowerCase().startsWith("re:") ? thread.subject : "Re: " + thread.subject,
            body: "Hi " + (thread.sender_name || "there") + ",\n\n" + reply + "\n\n— National Engineering Strategy Secretariat",
            threadId,
            messageRowId: msgRow.id,
            inReplyTo: lastInbound ? lastInbound.email_message_id : null,
          });
          await sql`UPDATE support_thread_messages SET resend_email_id = ${resendEmailId}, outbound_message_id = ${outboundMessageId} WHERE id = ${msgRow.id}`;
        } catch (err) {
          // Swallowed on purpose (see comment above).
        }
      }
      return res.status(200).json({ thread: { id: thread.id, status: "resolved" } });
    }

    if (action === "admin-import") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;

      const body = await readRawBody(req);
      if (!body.length) return res.status(400).json({ error: "No file data received." });

      let sheetRows;
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(body, { type: "buffer" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        sheetRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      } catch {
        return res.status(400).json({ error: "Couldn't read that file. Make sure it's a valid CSV or Excel (.xlsx) file." });
      }
      if (!sheetRows.length) return res.status(400).json({ error: "That file doesn't have any rows." });

      // Header names vary a lot in the wild ("Name" / "Full Name" / "Member
      // Name", "Membership No" / "IEK Number" / "No") — match loosely
      // instead of demanding one exact template.
      const NAME_PATTERNS = [/^name$/i, /full.?name/i, /member.*name/i, /^name/i];
      const NUMBER_PATTERNS = [/member.*(no|num|number)/i, /iek.*(no|num|number)/i, /membership/i, /^(no|num|number)$/i];
      function findKey(row, patterns) {
        const keys = Object.keys(row);
        for (const p of patterns) {
          const hit = keys.find((k) => p.test(k));
          if (hit) return hit;
        }
        return null;
      }

      const nameKey = findKey(sheetRows[0], NAME_PATTERNS);
      const numberKey = findKey(sheetRows[0], NUMBER_PATTERNS);
      if (!nameKey || !numberKey) {
        return res.status(400).json({ error: "Couldn't find a name column and a membership number column — check the file's headers." });
      }

      const existingRows = await sql`SELECT regexp_replace(iek_number, '[^0-9]', '', 'g') AS digits FROM engineers`;
      const existingDigits = new Set(existingRows.map((r) => r.digits));

      const toInsert = [];
      const skipped = [];
      const seenThisFile = new Set();
      sheetRows.forEach((row, i) => {
        const rawName = String(row[nameKey] ?? "").trim();
        const rawNumber = String(row[numberKey] ?? "").trim();
        const digits = digitsOnly(rawNumber);
        const rowNum = i + 2; // header is row 1
        if (!rawName || !digits) {
          skipped.push({ row: rowNum, name: rawName, iekNumber: rawNumber, reason: !rawName ? "Missing name" : "Missing/invalid membership number" });
        } else if (seenThisFile.has(digits)) {
          skipped.push({ row: rowNum, name: rawName, iekNumber: rawNumber, reason: "Duplicate membership number within this file" });
        } else if (existingDigits.has(digits)) {
          skipped.push({ row: rowNum, name: rawName, iekNumber: rawNumber, reason: "Membership number already exists" });
        } else {
          seenThisFile.add(digits);
          toInsert.push({ name: rawName, iekNumber: rawNumber });
        }
      });

      await Promise.all(toInsert.map((r) => sql`INSERT INTO engineers (iek_number, name) VALUES (${r.iekNumber}, ${r.name})`));

      return res.status(200).json({
        importedCount: toInsert.length,
        skippedCount: skipped.length,
        imported: toInsert,
        skipped,
      });
    }

    // =========================================================
    // VOTING — official elections (admin-run), member campaigns,
    // one-vote-per-engineer ballots, live results, and campaign SMS.
    // See migrations/016_elections.sql. This is a separate system from
    // the original turnout tracker (voting.html / api/candidates.js),
    // which is a check-in-desk tally and still holds the Aug-2026 data.
    // =========================================================
    if (action === "elections") {
      if (req.method === "GET") {
        const who = await requireMemberOrAdmin(sql, req, res);
        if (!who) return;
        const id = Number(req.query.id);
        // Live elections first, then upcoming soonest-first, then closed
        // most-recent-first — the same "which side of now" split the
        // Calendar listing uses, so the one that matters is always on top.
        const rows = await sql.query(
          `SELECT e.*, ${electionPhaseSql("e")} AS phase,
                  (SELECT COUNT(*) FROM campaigns c WHERE c.election_id = e.id AND c.status <> 'withdrawn')::int AS candidate_count,
                  (SELECT COUNT(*) FROM campaigns c WHERE c.election_id = e.id AND c.status <> 'withdrawn' AND c.verified)::int AS verified_count,
                  (SELECT COUNT(*) FROM campaign_votes v WHERE v.election_id = e.id)::int AS vote_count,
                  (SELECT COUNT(DISTINCT v.voter_id) FROM campaign_votes v WHERE v.election_id = e.id)::int AS voter_count
           FROM elections e
           WHERE ($1::int IS NULL OR e.id = $1)
           ORDER BY CASE ${electionPhaseSql("e")} WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END,
                    (CASE WHEN ${electionPhaseSql("e")} = 'upcoming' THEN e.opens_at END) ASC NULLS LAST,
                    (CASE WHEN ${electionPhaseSql("e")} = 'closed' THEN COALESCE(e.closed_at, e.closes_at) END) DESC NULLS LAST,
                    e.id DESC`,
          [Number.isInteger(id) && id > 0 ? id : null]
        );
        const [[totals], [indep]] = await Promise.all([
          sql`SELECT COUNT(*)::int AS total FROM engineers`,
          sql.query(
            `SELECT COUNT(*) FILTER (WHERE ${CAMPAIGN_PHASE_SQL} = 'live')::int AS live_count,
                    COUNT(*) FILTER (WHERE ${CAMPAIGN_PHASE_SQL} = 'upcoming')::int AS upcoming_count,
                    COALESCE(SUM((SELECT COUNT(*) FROM campaign_votes v WHERE v.campaign_id = c.id)), 0)::int AS vote_count
             FROM campaigns c LEFT JOIN elections e ON e.id = c.election_id
             WHERE c.election_id IS NULL AND c.status <> 'withdrawn'`,
            []
          ),
        ]);
        return res.status(200).json({
          elections: rows.map(mapElection),
          independent: { liveCount: indep.live_count, upcomingCount: indep.upcoming_count, voteCount: indep.vote_count },
          totalEngineers: totals.total,
          serverTime: new Date().toISOString(),
        });
      }

      const admin = await requireAdminSession(sql, req, res);
      if (!admin) return;

      if (req.method === "POST") {
        const b = req.body || {};
        const title = String(b.title || "").trim().slice(0, 200);
        const description = String(b.description || "").trim().slice(0, 3000) || null;
        const positions = cleanPositions(b.positions);
        const opensAt = parseInstant(b.opensAt);
        const closesAt = parseInstant(b.closesAt);
        if (!title) return res.status(400).json({ error: "Give the election a title." });
        if (!positions.length) return res.status(400).json({ error: "Add at least one position (e.g. President, Honorary Treasurer)." });
        if (opensAt === undefined || closesAt === undefined) return res.status(400).json({ error: "Invalid date/time." });
        if (opensAt && closesAt && closesAt <= opensAt) return res.status(400).json({ error: "Voting must close after it opens." });
        const [row] = await sql.query(
          `INSERT INTO elections (title, description, positions, opens_at, closes_at, nominations_open, auto_verify, created_by_email)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
           RETURNING *, ${electionPhaseSql("")} AS phase`,
          [title, description, JSON.stringify(positions), opensAt, closesAt, b.nominationsOpen !== false, !!b.autoVerify, admin.email]
        );
        await notifyAllEngineers(sql, "election_created", "election", row.id);
        return res.status(201).json({ election: mapElection(row) });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid election id." });
        const [existing] = await sql.query(`SELECT *, ${electionPhaseSql("")} AS phase FROM elections WHERE id = $1`, [id]);
        if (!existing) return res.status(404).json({ error: "Election not found." });
        const op = String(b.op || "update");

        if (op === "open") {
          // "Open voting now": start the window at this instant, clear any
          // manual close, and drop a scheduled close that's already in the
          // past (otherwise it would re-close the election immediately).
          await sql`
            UPDATE elections
            SET opens_at = CASE WHEN opens_at IS NULL OR opens_at > NOW() THEN NOW() ELSE opens_at END,
                closes_at = CASE WHEN closes_at IS NOT NULL AND closes_at <= NOW() THEN NULL ELSE closes_at END,
                closed_at = NULL, updated_at = NOW()
            WHERE id = ${id}
          `;
          if (existing.phase !== "live") await notifyAllEngineers(sql, "election_open", "election", id);
        } else if (op === "close") {
          await sql`UPDATE elections SET closed_at = NOW(), nominations_open = FALSE, updated_at = NOW() WHERE id = ${id}`;
        } else if (op === "reopen") {
          await sql`
            UPDATE elections
            SET closed_at = NULL,
                closes_at = CASE WHEN closes_at IS NOT NULL AND closes_at <= NOW() THEN NULL ELSE closes_at END,
                updated_at = NOW()
            WHERE id = ${id}
          `;
        } else if (op === "announce") {
          // Announcing results also closes voting if it's still open —
          // a result can't be final while ballots are still being cast.
          await sql`
            UPDATE elections
            SET winners_announced_at = NOW(), nominations_open = FALSE,
                closed_at = COALESCE(closed_at, CASE WHEN closes_at IS NOT NULL AND closes_at <= NOW() THEN closes_at ELSE NOW() END),
                updated_at = NOW()
            WHERE id = ${id}
          `;
          if (!existing.winners_announced_at) await notifyAllEngineers(sql, "election_results", "election", id);
        } else if (op === "unannounce") {
          await sql`UPDATE elections SET winners_announced_at = NULL, updated_at = NOW() WHERE id = ${id}`;
        } else if (op === "update") {
          const title = String(b.title ?? existing.title).trim().slice(0, 200);
          const description = b.description === undefined ? existing.description : String(b.description || "").trim().slice(0, 3000) || null;
          const positions = b.positions === undefined ? existing.positions : cleanPositions(b.positions);
          const opensAt = b.opensAt === undefined ? existing.opens_at : parseInstant(b.opensAt);
          const closesAt = b.closesAt === undefined ? existing.closes_at : parseInstant(b.closesAt);
          if (!title) return res.status(400).json({ error: "Give the election a title." });
          if (!positions.length) return res.status(400).json({ error: "Add at least one position." });
          if (opensAt === undefined || closesAt === undefined) return res.status(400).json({ error: "Invalid date/time." });
          if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) return res.status(400).json({ error: "Voting must close after it opens." });
          // A position can't be removed out from under campaigns already
          // running for it — those campaigns would silently drop off the ballot.
          const inUse = await sql`SELECT DISTINCT LOWER(position) AS p FROM campaigns WHERE election_id = ${id} AND status <> 'withdrawn'`;
          const keep = new Set(positions.map((p) => p.toLowerCase()));
          const missing = inUse.filter((r) => !keep.has(r.p));
          if (missing.length) return res.status(409).json({ error: `Can't remove a position that already has candidates: ${missing.map((m) => m.p).join(", ")}.` });
          await sql.query(
            `UPDATE elections SET title = $2, description = $3, positions = $4::jsonb, opens_at = $5, closes_at = $6,
                    nominations_open = $7, auto_verify = $8, updated_at = NOW()
             WHERE id = $1`,
            [id, title, description, JSON.stringify(positions), opensAt, closesAt,
             b.nominationsOpen === undefined ? existing.nominations_open : !!b.nominationsOpen,
             b.autoVerify === undefined ? existing.auto_verify : !!b.autoVerify]
          );
        } else {
          return res.status(400).json({ error: "Unknown op." });
        }
        const [row] = await sql.query(
          `SELECT e.*, ${electionPhaseSql("e")} AS phase,
                  (SELECT COUNT(*) FROM campaigns c WHERE c.election_id = e.id AND c.status <> 'withdrawn')::int AS candidate_count,
                  (SELECT COUNT(*) FROM campaigns c WHERE c.election_id = e.id AND c.status <> 'withdrawn' AND c.verified)::int AS verified_count,
                  (SELECT COUNT(*) FROM campaign_votes v WHERE v.election_id = e.id)::int AS vote_count,
                  (SELECT COUNT(DISTINCT v.voter_id) FROM campaign_votes v WHERE v.election_id = e.id)::int AS voter_count
           FROM elections e WHERE e.id = $1`,
          [id]
        );
        return res.status(200).json({ election: mapElection(row) });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid election id." });
        const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM campaign_votes WHERE election_id = ${id}`;
        if (count > 0) return res.status(409).json({ error: `This election has ${count} vote${count === 1 ? "" : "s"} recorded and can't be deleted. Close it instead.` });
        await sql`DELETE FROM notifications WHERE target_type = 'election' AND target_id = ${id}`;
        await sql`DELETE FROM elections WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "campaigns") {
      if (req.method === "GET") {
        const who = await requireMemberOrAdmin(sql, req, res);
        if (!who) return;
        const viewerId = who.viewerId;
        const id = Number(req.query.id);
        if (req.query.id !== undefined) {
          if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid campaign id." });
          const [row] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [viewerId, id]);
          if (!row) return res.status(404).json({ error: "Campaign not found." });
          const campaign = mapCampaign(row, viewerId);
          // Inside an election, "already voted in this position" matters as
          // much as "already voted for this campaign" — the ballot locks
          // the whole position once any candidate in it has been chosen.
          let myVoteCampaignId = null;
          if (viewerId) {
            const [mine] = campaign.electionId
              ? await sql`SELECT campaign_id FROM campaign_votes WHERE voter_id = ${viewerId} AND election_id = ${campaign.electionId} AND LOWER(position) = LOWER(${campaign.position})`
              : await sql`SELECT campaign_id FROM campaign_votes WHERE voter_id = ${viewerId} AND campaign_id = ${id}`;
            myVoteCampaignId = mine ? mine.campaign_id : null;
          }
          const [[{ total }], [electionRow]] = await Promise.all([
            sql`SELECT COUNT(*)::int AS total FROM engineers`,
            campaign.electionId
              ? sql.query(`SELECT e.*, ${electionPhaseSql("e")} AS phase FROM elections e WHERE e.id = $1`, [campaign.electionId])
              : Promise.resolve([null]),
          ]);
          return res.status(200).json({
            campaign,
            election: electionRow ? mapElection(electionRow) : null,
            myVoteCampaignId,
            totalEngineers: total,
            serverTime: new Date().toISOString(),
          });
        }

        const where = ["c.status <> 'withdrawn'"];
        const params = [viewerId];
        if (req.query.mine === "1" && viewerId) {
          where.pop();
          params.push(viewerId);
          where.push(`c.creator_id = $${params.length}`);
        } else if (req.query.electionId) {
          const eid = Number(req.query.electionId);
          if (!Number.isInteger(eid)) return res.status(400).json({ error: "Invalid election id." });
          params.push(eid);
          where.push(`c.election_id = $${params.length}`);
        } else if (req.query.scope === "independent") {
          where.push("c.election_id IS NULL");
          if (req.query.includeEnded !== "1") where.push(`${CAMPAIGN_PHASE_SQL} <> 'ended'`);
        } else if (req.query.includeEnded !== "1") {
          where.push(`${CAMPAIGN_PHASE_SQL} <> 'ended'`);
        }
        if (req.query.position) {
          params.push(String(req.query.position));
          where.push(`LOWER(c.position) = LOWER($${params.length})`);
        }
        const rows = await sql.query(
          `${CAMPAIGN_SELECT_SQL} WHERE ${where.join(" AND ")}
           ORDER BY CASE ${CAMPAIGN_PHASE_SQL} WHEN 'live' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END, c.verified DESC, c.created_at ASC
           LIMIT 200`,
          params
        );
        return res.status(200).json({ campaigns: rows.map((r) => mapCampaign(r, viewerId)), serverTime: new Date().toISOString() });
      }

      if (req.method === "POST") {
        const session = await requireSession(sql, req, res);
        if (!session) return;
        const b = req.body || {};
        const name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 150);
        let position = String(b.position || "").trim().replace(/\s+/g, " ").slice(0, 120);
        const bio = String(b.bio || "").trim().slice(0, 3000) || null;
        const photoUrl = String(b.photoUrl || "").trim().slice(0, 500) || null;
        if (name.length < 3) return res.status(400).json({ error: "Give your campaign a name (e.g. \"Jane for Treasurer\")." });
        if (position.length < 2) return res.status(400).json({ error: "Choose the position you're running for." });
        if (photoUrl && !/^https:\/\//.test(photoUrl)) return res.status(400).json({ error: "Invalid photo." });

        let electionId = null;
        let verified = false;
        let startsAt = null;
        let endsAt = null;
        if (b.electionId) {
          electionId = Number(b.electionId);
          if (!Number.isInteger(electionId)) return res.status(400).json({ error: "Invalid election." });
          const [election] = await sql.query(`SELECT *, ${electionPhaseSql("")} AS phase FROM elections WHERE id = $1`, [electionId]);
          if (!election) return res.status(404).json({ error: "That election no longer exists." });
          if (election.phase === "closed") return res.status(409).json({ error: "That election has closed." });
          if (!election.nominations_open) return res.status(409).json({ error: "Nominations for that election are closed." });
          const canonical = (Array.isArray(election.positions) ? election.positions : []).find((p) => p.toLowerCase() === position.toLowerCase());
          if (!canonical) return res.status(400).json({ error: "Pick one of the positions in this election." });
          position = canonical;
          verified = !!election.auto_verify;
        } else {
          startsAt = parseInstant(b.startsAt) || new Date();
          endsAt = parseInstant(b.endsAt);
          if (startsAt === undefined || endsAt === undefined) return res.status(400).json({ error: "Invalid campaign dates." });
          if (!endsAt) return res.status(400).json({ error: "Set when your campaign ends." });
          if (endsAt <= new Date()) return res.status(400).json({ error: "The campaign end date must be in the future." });
          if (endsAt <= startsAt) return res.status(400).json({ error: "The campaign must end after it starts." });
          if (endsAt - startsAt > CAMPAIGN_MAX_DAYS * 86400000) return res.status(400).json({ error: `A campaign can run for at most ${CAMPAIGN_MAX_DAYS} days.` });
        }

        let created;
        try {
          [created] = await sql`
            INSERT INTO campaigns (election_id, creator_id, name, position, bio, photo_url, starts_at, ends_at, verified, verified_at)
            VALUES (${electionId}, ${session.id}, ${name}, ${position}, ${bio}, ${photoUrl}, ${startsAt}, ${endsAt}, ${verified}, ${verified ? new Date() : null})
            RETURNING id
          `;
        } catch (err) {
          if (err && err.code === "23505") return res.status(409).json({ error: "You already have a campaign for this position." });
          throw err;
        }
        await logActivity(sql, session.id, "campaign", `${session.display_name || session.name} launched a campaign for ${position}`);
        const [row] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [session.id, created.id]);
        return res.status(201).json({ campaign: mapCampaign(row, session.id) });
      }

      if (req.method === "PUT") {
        const b = req.body || {};
        const id = Number(b.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid campaign id." });
        const admin = await getAdminSessionSilently(sql, req);
        if (admin) {
          // Admin's only edit is verification — the candidate owns everything else.
          if (typeof b.verified !== "boolean") return res.status(400).json({ error: "verified must be true or false." });
          const [updated] = await sql`
            UPDATE campaigns
            SET verified = ${b.verified}, verified_by_email = ${b.verified ? admin.email : null}, verified_at = ${b.verified ? new Date() : null}, updated_at = NOW()
            WHERE id = ${id}
            RETURNING creator_id, position
          `;
          if (!updated) return res.status(404).json({ error: "Campaign not found." });
          if (b.verified) {
            await sql`
              INSERT INTO notifications (recipient_id, actor_id, type, target_type, target_id)
              VALUES (${updated.creator_id}, NULL, 'campaign_verified', 'campaign', ${id})
            `.catch(() => {});
          }
          const [row] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [null, id]);
          return res.status(200).json({ campaign: mapCampaign(row, null) });
        }

        const session = await requireSession(sql, req, res);
        if (!session) return;
        const [existing] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [session.id, id]);
        if (!existing) return res.status(404).json({ error: "Campaign not found." });
        if (existing.creator_id !== session.id) return res.status(403).json({ error: "Only the candidate can edit this campaign." });
        if (existing.status === "withdrawn") return res.status(409).json({ error: "This campaign has been withdrawn." });

        const name = b.name === undefined ? existing.name : String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 150);
        const bio = b.bio === undefined ? existing.bio : String(b.bio || "").trim().slice(0, 3000) || null;
        const photoUrl = b.photoUrl === undefined ? existing.photo_url : String(b.photoUrl || "").trim().slice(0, 500) || null;
        let position = existing.position;
        let endsAt = existing.ends_at;
        if (name.length < 3) return res.status(400).json({ error: "Give your campaign a name." });
        if (photoUrl && !/^https:\/\//.test(photoUrl)) return res.status(400).json({ error: "Invalid photo." });
        if (b.position !== undefined && String(b.position).trim().toLowerCase() !== existing.position.toLowerCase()) {
          if (existing.votes > 0) return res.status(409).json({ error: "The position can't change once votes have been cast." });
          position = String(b.position).trim().replace(/\s+/g, " ").slice(0, 120);
          if (position.length < 2) return res.status(400).json({ error: "Choose a position." });
          if (existing.election_id) {
            const [election] = await sql`SELECT positions FROM elections WHERE id = ${existing.election_id}`;
            const canonical = (election && Array.isArray(election.positions) ? election.positions : []).find((p) => p.toLowerCase() === position.toLowerCase());
            if (!canonical) return res.status(400).json({ error: "Pick one of the positions in this election." });
            position = canonical;
          }
        }
        if (!existing.election_id && b.endsAt !== undefined) {
          endsAt = parseInstant(b.endsAt);
          if (endsAt === undefined || !endsAt) return res.status(400).json({ error: "Invalid end date." });
          if (endsAt <= new Date()) return res.status(400).json({ error: "The campaign end date must be in the future." });
          if (endsAt - new Date(existing.starts_at) > CAMPAIGN_MAX_DAYS * 86400000) return res.status(400).json({ error: `A campaign can run for at most ${CAMPAIGN_MAX_DAYS} days.` });
        }
        try {
          await sql`
            UPDATE campaigns SET name = ${name}, bio = ${bio}, photo_url = ${photoUrl}, position = ${position}, ends_at = ${endsAt}, updated_at = NOW()
            WHERE id = ${id}
          `;
        } catch (err) {
          if (err && err.code === "23505") return res.status(409).json({ error: "You already have a campaign for that position." });
          throw err;
        }
        const [row] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [session.id, id]);
        return res.status(200).json({ campaign: mapCampaign(row, session.id) });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid campaign id." });
        const admin = await getAdminSessionSilently(sql, req);
        let session = null;
        if (!admin) {
          session = await requireSession(sql, req, res);
          if (!session) return;
        }
        const [existing] = await sql`
          SELECT c.id, c.creator_id, c.status, (SELECT COUNT(*) FROM campaign_votes v WHERE v.campaign_id = c.id)::int AS votes
          FROM campaigns c WHERE c.id = ${id}
        `;
        if (!existing) return res.status(404).json({ error: "Campaign not found." });
        if (session && existing.creator_id !== session.id) return res.status(403).json({ error: "Only the candidate can remove this campaign." });
        if (req.query.withdraw === "1") {
          // Withdrawing keeps the ballots already cast on record (an
          // audit trail matters more than a clean table) but takes the
          // campaign off the ballot and out of the results.
          await sql`UPDATE campaigns SET status = 'withdrawn', updated_at = NOW() WHERE id = ${id}`;
          return res.status(200).json({ success: true, withdrawn: true });
        }
        if (existing.votes > 0) {
          return res.status(409).json({ error: `This campaign already has ${existing.votes} vote${existing.votes === 1 ? "" : "s"} and can't be deleted. You can withdraw it instead.`, canWithdraw: true });
        }
        await sql`DELETE FROM notifications WHERE target_type = 'campaign' AND target_id = ${id}`;
        await sql`DELETE FROM campaigns WHERE id = ${id}`;
        return res.status(200).json({ success: true, deleted: true });
      }

      res.setHeader("Allow", "GET, POST, PUT, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "upload-campaign-photo") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const contentType = req.headers["content-type"] || "";
      if (!contentType.startsWith("image/")) return res.status(400).json({ error: "Only image uploads are allowed." });
      const body = await readRawBody(req);
      if (!body.length) return res.status(400).json({ error: "No image data received." });
      if (body.length > MAX_PHOTO_BYTES) return res.status(413).json({ error: "Image is too large. Keep it under 10MB." });
      const ext = contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "jpg";
      const blob = await put(`campaign-photos/${session.id}-${Date.now()}.${ext}`, body, { access: "public", contentType });
      return res.status(200).json({ url: blob.url });
    }

    if (action === "ballot") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM engineers`;

      if (req.query.electionId) {
        const eid = Number(req.query.electionId);
        if (!Number.isInteger(eid)) return res.status(400).json({ error: "Invalid election id." });
        const [election] = await sql.query(
          `SELECT e.*, ${electionPhaseSql("e")} AS phase,
                  (SELECT COUNT(*) FROM campaigns c WHERE c.election_id = e.id AND c.status <> 'withdrawn')::int AS candidate_count,
                  (SELECT COUNT(*) FROM campaigns c WHERE c.election_id = e.id AND c.status <> 'withdrawn' AND c.verified)::int AS verified_count,
                  (SELECT COUNT(*) FROM campaign_votes v WHERE v.election_id = e.id)::int AS vote_count,
                  (SELECT COUNT(DISTINCT v.voter_id) FROM campaign_votes v WHERE v.election_id = e.id)::int AS voter_count
           FROM elections e WHERE e.id = $1`,
          [eid]
        );
        if (!election) return res.status(404).json({ error: "Election not found." });
        // Ballot order is by verification then entry order — deliberately
        // NOT by vote count, so the ballot itself never nudges a voter
        // toward whoever is currently ahead. Ranking lives on the results page.
        const [rows, myVotes] = await Promise.all([
          sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.election_id = $2 AND c.status <> 'withdrawn' ORDER BY c.verified DESC, c.created_at ASC`, [session.id, eid]),
          sql`SELECT campaign_id, LOWER(position) AS position FROM campaign_votes WHERE voter_id = ${session.id} AND election_id = ${eid}`,
        ]);
        const mineByPosition = new Map(myVotes.map((v) => [v.position, v.campaign_id]));
        const campaigns = rows.map((r) => mapCampaign(r, session.id));
        const positions = mapElection(election).positions.map((p) => ({
          position: p,
          myVoteCampaignId: mineByPosition.get(p.toLowerCase()) || null,
          candidates: campaigns.filter((c) => c.position.toLowerCase() === p.toLowerCase()),
        }));
        return res.status(200).json({
          election: mapElection(election),
          phase: election.phase,
          positions,
          myVoteCount: myVotes.length,
          totalEngineers: total,
          serverTime: new Date().toISOString(),
        });
      }

      // Independent campaigns: one vote per engineer per campaign, each
      // campaign on its own clock. Grouped by position for display only.
      const rows = await sql.query(
        `${CAMPAIGN_SELECT_SQL} WHERE c.election_id IS NULL AND c.status <> 'withdrawn' AND ${CAMPAIGN_PHASE_SQL} <> 'ended'
         ORDER BY CASE ${CAMPAIGN_PHASE_SQL} WHEN 'live' THEN 0 ELSE 1 END, c.created_at ASC`,
        [session.id]
      );
      const campaigns = rows.map((r) => mapCampaign(r, session.id));
      const byPosition = new Map();
      for (const c of campaigns) {
        const key = c.position.toLowerCase();
        if (!byPosition.has(key)) byPosition.set(key, { position: c.position, myVoteCampaignId: null, candidates: [] });
        byPosition.get(key).candidates.push(c);
      }
      const [{ voters }] = await sql`
        SELECT COUNT(DISTINCT v.voter_id)::int AS voters FROM campaign_votes v JOIN campaigns c ON c.id = v.campaign_id
        WHERE c.election_id IS NULL AND c.status <> 'withdrawn'
      `;
      return res.status(200).json({
        election: null,
        phase: campaigns.some((c) => c.isLive) ? "live" : campaigns.length ? "upcoming" : "none",
        positions: Array.from(byPosition.values()),
        myVoteCount: campaigns.filter((c) => c.myVoted).length,
        voterCount: voters,
        totalEngineers: total,
        serverTime: new Date().toISOString(),
      });
    }

    if (action === "vote") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const campaignId = Number((req.body || {}).campaignId);
      if (!Number.isInteger(campaignId)) return res.status(400).json({ error: "Invalid campaign." });
      const [row] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [session.id, campaignId]);
      if (!row) return res.status(404).json({ error: "Campaign not found." });
      const campaign = mapCampaign(row, session.id);
      if (campaign.status === "withdrawn") return res.status(409).json({ error: "This campaign has been withdrawn." });
      if (campaign.phase === "upcoming") return res.status(409).json({ error: "Voting hasn't opened yet." });
      if (campaign.phase === "ended") return res.status(409).json({ error: "Voting has closed." });
      if (!campaign.canReceiveVotes) return res.status(409).json({ error: "This candidate hasn't been verified yet, so votes can't be cast for them." });

      // The two unique indexes on campaign_votes (voter+campaign, and
      // voter+election+position) are what actually enforce "one vote, no
      // changes" — under two simultaneous taps only one INSERT can win,
      // and ON CONFLICT DO NOTHING turns the loser into a clean "already
      // voted" instead of a 500. No read-then-write window at all.
      const inserted = await sql`
        INSERT INTO campaign_votes (campaign_id, voter_id, election_id, position, voter_ip)
        VALUES (${campaignId}, ${session.id}, ${campaign.electionId}, ${campaign.position}, ${getClientIp(req)})
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (!inserted.length) {
        const [prior] = campaign.electionId
          ? await sql`SELECT v.campaign_id, c.name, cr.display_name, cr.name AS creator_name FROM campaign_votes v JOIN campaigns c ON c.id = v.campaign_id JOIN engineers cr ON cr.id = c.creator_id WHERE v.voter_id = ${session.id} AND v.election_id = ${campaign.electionId} AND LOWER(v.position) = LOWER(${campaign.position})`
          : await sql`SELECT v.campaign_id, c.name, cr.display_name, cr.name AS creator_name FROM campaign_votes v JOIN campaigns c ON c.id = v.campaign_id JOIN engineers cr ON cr.id = c.creator_id WHERE v.voter_id = ${session.id} AND v.campaign_id = ${campaignId}`;
        const who = prior ? prior.display_name || prior.creator_name : "a candidate";
        return res.status(409).json({
          error: prior && prior.campaign_id === campaignId
            ? `You've already voted for ${who}. Votes can't be changed.`
            : `You've already voted for ${who} for ${campaign.position}. Votes can't be changed.`,
          myVoteCampaignId: prior ? prior.campaign_id : null,
        });
      }
      await logAudit(sql, "HUB_VOTE", session.id, getClientIp(req)).catch(() => {});
      const [{ votes }] = await sql`SELECT COUNT(*)::int AS votes FROM campaign_votes WHERE campaign_id = ${campaignId}`;
      return res.status(200).json({ success: true, campaign: { id: campaignId, votes }, myVoteCampaignId: campaignId });
    }

    if (action === "election-results") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const who = await requireMemberOrAdmin(sql, req, res);
      if (!who) return;
      const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM engineers`;
      let election = null;
      let rows;
      let voterCount = 0;
      let lastVoteAt = null;
      let positionOrder;
      if (req.query.electionId) {
        const eid = Number(req.query.electionId);
        if (!Number.isInteger(eid)) return res.status(400).json({ error: "Invalid election id." });
        const [e] = await sql.query(`SELECT e.*, ${electionPhaseSql("e")} AS phase FROM elections e WHERE e.id = $1`, [eid]);
        if (!e) return res.status(404).json({ error: "Election not found." });
        election = mapElection(e);
        positionOrder = election.positions;
        const [campaignRows, [agg]] = await Promise.all([
          sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.election_id = $2 AND c.status <> 'withdrawn'`, [null, eid]),
          sql`SELECT COUNT(DISTINCT voter_id)::int AS voters, MAX(created_at) AS last_vote_at FROM campaign_votes WHERE election_id = ${eid}`,
        ]);
        rows = campaignRows;
        voterCount = agg.voters;
        lastVoteAt = agg.last_vote_at;
      } else {
        const [campaignRows, [agg]] = await Promise.all([
          sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.election_id IS NULL AND c.status <> 'withdrawn' AND (${CAMPAIGN_PHASE_SQL} <> 'ended' OR c.ends_at > NOW() - INTERVAL '30 days')`, [null]),
          sql`SELECT COUNT(DISTINCT v.voter_id)::int AS voters, MAX(v.created_at) AS last_vote_at FROM campaign_votes v JOIN campaigns c ON c.id = v.campaign_id WHERE c.election_id IS NULL AND c.status <> 'withdrawn'`,
        ]);
        rows = campaignRows;
        voterCount = agg.voters;
        lastVoteAt = agg.last_vote_at;
        positionOrder = [];
        for (const r of rows) if (!positionOrder.some((p) => p.toLowerCase() === r.position.toLowerCase())) positionOrder.push(r.position);
      }
      const campaigns = rows.map((r) => mapCampaign(r, null));
      const announced = !!(election && election.winnersAnnouncedAt);
      const positions = positionOrder.map((p) => {
        const cands = campaigns
          .filter((c) => c.position.toLowerCase() === p.toLowerCase())
          .sort((a, b) => b.votes - a.votes || new Date(a.createdAt) - new Date(b.createdAt));
        const totalVotes = cands.reduce((s, c) => s + c.votes, 0);
        const top = cands.length ? cands[0].votes : 0;
        const leaders = cands.filter((c) => c.votes === top && top > 0);
        return {
          position: p,
          totalVotes,
          candidates: cands.map((c) => ({
            id: c.id,
            name: c.name,
            candidateName: c.candidateName,
            photoUrl: c.photoUrl,
            verified: c.verified,
            phase: c.phase,
            votes: c.votes,
            percent: totalVotes ? Math.round((c.votes / totalVotes) * 1000) / 10 : 0,
            isLeader: c.votes === top && top > 0,
            isTie: leaders.length > 1 && c.votes === top && top > 0,
            isWinner: announced && leaders.length === 1 && c.votes === top && top > 0,
          })),
        };
      });
      const totalVotes = positions.reduce((s, p) => s + p.totalVotes, 0);
      const payload = {
        election,
        phase: election ? election.phase : campaigns.some((c) => c.isLive) ? "live" : campaigns.length ? "closed" : "none",
        positions,
        totalVotes,
        voterCount,
        totalEngineers: total,
        turnoutPercent: total ? Math.round((voterCount / total) * 1000) / 10 : 0,
        lastVoteAt,
        winnersAnnouncedAt: election ? election.winnersAnnouncedAt : null,
        serverTime: new Date().toISOString(),
      };

      if (req.query.format === "csv") {
        const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
        const lines = [["Position", "Candidate", "Campaign", "Votes", "Percent of position", "Verified", "Status"].map(esc).join(",")];
        for (const p of positions) {
          for (const c of p.candidates) {
            lines.push([p.position, c.candidateName, c.name, c.votes, c.percent + "%", c.verified ? "Yes" : "No", c.isWinner ? "Winner" : c.isTie ? "Tied lead" : c.isLeader ? "Leading" : ""].map(esc).join(","));
          }
        }
        lines.push("");
        lines.push([esc("Total votes"), esc(totalVotes)].join(","));
        lines.push([esc("Engineers who voted"), esc(voterCount)].join(","));
        lines.push([esc("Registered engineers"), esc(total)].join(","));
        lines.push([esc("Turnout"), esc(payload.turnoutPercent + "%")].join(","));
        lines.push([esc("Exported at"), esc(new Date().toISOString())].join(","));
        const fname = (election ? election.title : "independent-campaigns").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="results-${fname}.csv"`);
        return res.status(200).send("﻿" + lines.join("\r\n"));
      }
      return res.status(200).json(payload);
    }

    // ---------- Campaign SMS (Sozuri, via api/_sozuri.js) ----------
    if (action === "campaign-sms-recipients") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const campaignId = Number(req.query.campaignId);
      if (!Number.isInteger(campaignId)) return res.status(400).json({ error: "Invalid campaign." });
      const [campaign] = await sql`SELECT id, creator_id, election_id, position FROM campaigns WHERE id = ${campaignId}`;
      if (!campaign) return res.status(404).json({ error: "Campaign not found." });
      if (campaign.creator_id !== session.id) return res.status(403).json({ error: "Only the candidate can message on behalf of this campaign." });
      // "Has voted" is scoped to the contest, not the candidate: inside an
      // election it means "has cast a ballot for this position" (for
      // anyone), which is turnout information, not how they voted — the
      // candidate never learns who chose whom. An independent campaign is
      // its own contest, so there it means voted for this campaign.
      const rows = await sql`
        SELECT e.id, COALESCE(NULLIF(e.display_name, ''), e.name) AS name, e.discipline,
               (e.phone IS NOT NULL AND e.phone <> '') AS has_phone,
               EXISTS(
                 SELECT 1 FROM campaign_votes v
                 WHERE v.voter_id = e.id AND (
                   (${campaign.election_id}::int IS NOT NULL AND v.election_id = ${campaign.election_id} AND LOWER(v.position) = LOWER(${campaign.position}))
                   OR (${campaign.election_id}::int IS NULL AND v.campaign_id = ${campaignId})
                 )
               ) AS has_voted
        FROM engineers e
        ORDER BY name
      `;
      const disciplines = Array.from(new Set(rows.map((r) => r.discipline).filter(Boolean))).sort();
      return res.status(200).json({
        engineers: rows.map((r) => ({ id: r.id, name: r.name, discipline: r.discipline, hasPhone: !!r.has_phone, hasVoted: !!r.has_voted })),
        disciplines,
        counts: {
          all: rows.length,
          withPhone: rows.filter((r) => r.has_phone).length,
          notVoted: rows.filter((r) => r.has_phone && !r.has_voted).length,
          voted: rows.filter((r) => r.has_voted).length,
        },
        smsConfigured: smsIsConfigured(),
      });
    }

    if (action === "campaign-sms") {
      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "GET") {
        const campaignId = Number(req.query.campaignId);
        if (!Number.isInteger(campaignId)) return res.status(400).json({ error: "Invalid campaign." });
        const [campaign] = await sql`SELECT id, creator_id FROM campaigns WHERE id = ${campaignId}`;
        if (!campaign) return res.status(404).json({ error: "Campaign not found." });
        if (campaign.creator_id !== session.id) return res.status(403).json({ error: "Only the candidate can see this campaign's messages." });
        const [batches, [{ today }]] = await Promise.all([
          sql`
            SELECT b.*,
                   (SELECT COUNT(*) FROM campaign_sms_recipients r WHERE r.batch_id = b.id AND r.status IN ('pending', 'sending'))::int AS open_count,
                   (SELECT COUNT(*) FROM campaign_sms_recipients r WHERE r.batch_id = b.id AND r.status = 'sent')::int AS live_sent,
                   (SELECT COUNT(*) FROM campaign_sms_recipients r WHERE r.batch_id = b.id AND r.status = 'failed')::int AS live_failed,
                   (SELECT COUNT(*) FROM campaign_sms_recipients r WHERE r.batch_id = b.id AND r.status = 'invalid_phone')::int AS live_invalid
            FROM campaign_sms_batches b WHERE b.campaign_id = ${campaignId} ORDER BY b.created_at DESC LIMIT 50
          `,
          sql`SELECT COUNT(*)::int AS today FROM campaign_sms_batches WHERE campaign_id = ${campaignId} AND status <> 'cancelled' AND created_at > NOW() - INTERVAL '24 hours'`,
        ]);
        return res.status(200).json({
          batches: batches.map((b) => ({
            id: b.id,
            message: b.message,
            recipientMode: b.recipient_mode,
            recipientFilter: b.recipient_filter,
            recipientsCount: b.recipients_count,
            sentCount: b.live_sent,
            failedCount: b.live_failed,
            invalidCount: b.live_invalid,
            openCount: b.open_count,
            status: b.status,
            scheduledFor: b.scheduled_for,
            startedAt: b.started_at,
            completedAt: b.completed_at,
            createdAt: b.created_at,
          })),
          remainingToday: Math.max(0, CAMPAIGN_SMS_DAILY_LIMIT - today),
          dailyLimit: CAMPAIGN_SMS_DAILY_LIMIT,
          maxChars: CAMPAIGN_SMS_MAX_CHARS,
          smsConfigured: smsIsConfigured(),
        });
      }

      if (req.method === "POST") {
        const b = req.body || {};
        const campaignId = Number(b.campaignId);
        if (!Number.isInteger(campaignId)) return res.status(400).json({ error: "Invalid campaign." });
        const [row] = await sql.query(`${CAMPAIGN_SELECT_SQL} WHERE c.id = $2`, [session.id, campaignId]);
        if (!row) return res.status(404).json({ error: "Campaign not found." });
        const campaign = mapCampaign(row, session.id);
        if (!campaign.isOwner) return res.status(403).json({ error: "Only the candidate can message on behalf of this campaign." });
        if (campaign.status === "withdrawn" || campaign.phase === "ended") return res.status(409).json({ error: "This campaign is no longer running." });
        if (campaign.electionId && !campaign.verified) return res.status(409).json({ error: "Your candidacy has to be verified by the election admin before you can send SMS." });
        if (!smsIsConfigured()) return res.status(400).json({ error: "SMS isn't configured on the server yet (SOZURI_PROJECT_ID / SOZURI_API_KEY)." });

        const [{ today }] = await sql`SELECT COUNT(*)::int AS today FROM campaign_sms_batches WHERE campaign_id = ${campaignId} AND status <> 'cancelled' AND created_at > NOW() - INTERVAL '24 hours'`;
        if (today >= CAMPAIGN_SMS_DAILY_LIMIT) return res.status(429).json({ error: `You've reached the limit of ${CAMPAIGN_SMS_DAILY_LIMIT} SMS sends per campaign in 24 hours.` });

        const text = String(b.message || "").replace(/\r\n/g, "\n").trim();
        if (!text) return res.status(400).json({ error: "Write your message first." });
        if (text.length > CAMPAIGN_SMS_MAX_CHARS) return res.status(400).json({ error: `Keep the message under ${CAMPAIGN_SMS_MAX_CHARS} characters.` });
        // The sender ID on the wire is the account's registered
        // alphanumeric ID (SOZURI_SENDER) — carriers don't allow that to
        // change per message — so "sent from the candidate's name" is done
        // in the text itself: the candidate signs off, with a link straight
        // to their campaign page.
        const signature = b.includeSignature === false ? "" : `\n- ${campaign.candidateName}, ${campaign.position}. ${campaignLink(req, campaignId)}`;
        const message = text + signature;

        const mode = ["all", "discipline", "individual", "not_voted"].includes(b.mode) ? b.mode : "all";
        let recipients;
        let filterLabel = null;
        if (mode === "individual") {
          const ids = Array.from(new Set((Array.isArray(b.engineerIds) ? b.engineerIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
          if (!ids.length) return res.status(400).json({ error: "Select at least one engineer." });
          recipients = await sql`SELECT id, phone FROM engineers WHERE id = ANY(${ids}) AND phone IS NOT NULL AND phone <> ''`;
        } else if (mode === "discipline") {
          filterLabel = String(b.discipline || "").trim().slice(0, 150);
          if (!filterLabel) return res.status(400).json({ error: "Choose a discipline." });
          recipients = await sql`SELECT id, phone FROM engineers WHERE discipline = ${filterLabel} AND phone IS NOT NULL AND phone <> ''`;
        } else if (mode === "not_voted") {
          recipients = await sql`
            SELECT e.id, e.phone FROM engineers e
            WHERE e.phone IS NOT NULL AND e.phone <> '' AND NOT EXISTS (
              SELECT 1 FROM campaign_votes v WHERE v.voter_id = e.id AND (
                (${campaign.electionId}::int IS NOT NULL AND v.election_id = ${campaign.electionId} AND LOWER(v.position) = LOWER(${campaign.position}))
                OR (${campaign.electionId}::int IS NULL AND v.campaign_id = ${campaignId})
              )
            )
          `;
        } else {
          recipients = await sql`SELECT id, phone FROM engineers WHERE phone IS NOT NULL AND phone <> ''`;
        }
        if (!recipients.length) return res.status(400).json({ error: "No one matches that selection (or none of them has a phone number on file)." });

        let scheduledFor = parseInstant(b.scheduledFor);
        if (scheduledFor === undefined) return res.status(400).json({ error: "Invalid schedule time." });
        const immediate = !scheduledFor || scheduledFor.getTime() - Date.now() < 60 * 1000;
        if (immediate) scheduledFor = new Date();
        if (scheduledFor.getTime() - Date.now() > 30 * 86400000) return res.status(400).json({ error: "Schedule at most 30 days ahead." });

        const [batch] = await sql`
          INSERT INTO campaign_sms_batches (campaign_id, sender_id, message, recipient_mode, recipient_filter, recipients_count, status, scheduled_for)
          VALUES (${campaignId}, ${session.id}, ${message}, ${mode}, ${filterLabel}, ${recipients.length}, ${immediate ? "sending" : "scheduled"}, ${scheduledFor})
          RETURNING *
        `;
        const ids = recipients.map((r) => r.id);
        await sql`
          INSERT INTO campaign_sms_recipients (batch_id, engineer_id, phone)
          SELECT ${batch.id}, e.id, e.phone FROM engineers e WHERE e.id = ANY(${ids})
        `;
        return res.status(201).json({
          batch: { id: batch.id, status: batch.status, recipientsCount: batch.recipients_count, scheduledFor: batch.scheduled_for, message: batch.message, immediate },
        });
      }

      if (req.method === "DELETE") {
        const id = Number(req.query.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid batch." });
        const [batch] = await sql`SELECT id, sender_id, status FROM campaign_sms_batches WHERE id = ${id}`;
        if (!batch) return res.status(404).json({ error: "Not found." });
        if (batch.sender_id !== session.id) return res.status(403).json({ error: "Not yours to cancel." });
        if (batch.status !== "scheduled") return res.status(409).json({ error: "Only a scheduled send can be cancelled." });
        await sql`UPDATE campaign_sms_batches SET status = 'cancelled', completed_at = NOW() WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: "Method not allowed." });
    }

    if (action === "campaign-sms-batch") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const id = Number(req.query.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid batch." });
      const [batch] = await sql`
        SELECT b.*, c.election_id, c.position FROM campaign_sms_batches b JOIN campaigns c ON c.id = b.campaign_id WHERE b.id = ${id}
      `;
      if (!batch) return res.status(404).json({ error: "Not found." });
      if (batch.sender_id !== session.id) return res.status(403).json({ error: "Not yours to view." });
      const rows = await sql`
        SELECT r.id, r.status, r.provider_status, r.error, r.sent_at,
               COALESCE(NULLIF(e.display_name, ''), e.name) AS name,
               EXISTS(
                 SELECT 1 FROM campaign_votes v
                 WHERE v.voter_id = e.id AND (
                   (${batch.election_id}::int IS NOT NULL AND v.election_id = ${batch.election_id} AND LOWER(v.position) = LOWER(${batch.position}))
                   OR (${batch.election_id}::int IS NULL AND v.campaign_id = ${batch.campaign_id})
                 )
               ) AS has_voted
        FROM campaign_sms_recipients r JOIN engineers e ON e.id = r.engineer_id
        WHERE r.batch_id = ${id}
        ORDER BY name
      `;
      return res.status(200).json({
        batch: {
          id: batch.id, message: batch.message, recipientMode: batch.recipient_mode, recipientFilter: batch.recipient_filter,
          recipientsCount: batch.recipients_count, status: batch.status, scheduledFor: batch.scheduled_for,
          startedAt: batch.started_at, completedAt: batch.completed_at, createdAt: batch.created_at,
        },
        recipients: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, providerStatus: r.provider_status, error: r.error, sentAt: r.sent_at, hasVoted: !!r.has_voted })),
      });
    }

    // The dispatcher. There's no always-on worker in this deployment
    // (Vercel Hobby crons are once-a-day, useless for "send at 9:00"), so
    // sending is driven by whoever's browser is open: the candidate's
    // own page loops on this right after an immediate send (that's what
    // powers their progress bar), and the Voting/results pages poke it
    // in the background so a scheduled batch still goes out on time.
    // Every call claims at most one small chunk of one batch; concurrent
    // callers get disjoint chunks (FOR UPDATE SKIP LOCKED inside a single
    // statement), so two open browsers never double-send a recipient.
    if (action === "campaign-sms-dispatch") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      // A recipient stuck in 'sending' means a dispatcher died between
      // claiming it and recording the result. Mark it failed rather than
      // re-queue it — a duplicate SMS to a real voter is worse than one
      // marked failed that the candidate can see and resend.
      await sql`
        UPDATE campaign_sms_recipients SET status = 'failed', error = 'Sender timed out — not confirmed'
        WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '5 minutes'
      `;
      const [batch] = await sql`
        UPDATE campaign_sms_batches
        SET status = 'sending', started_at = COALESCE(started_at, NOW())
        WHERE id = (
          SELECT id FROM campaign_sms_batches
          WHERE status = 'sending' OR (status = 'scheduled' AND scheduled_for <= NOW())
          ORDER BY scheduled_for ASC, id ASC
          LIMIT 1
        )
        RETURNING *
      `;
      if (!batch) return res.status(200).json({ batchId: null, processed: 0, remaining: 0 });

      const claimed = await sql`
        UPDATE campaign_sms_recipients r
        SET status = 'sending', claimed_at = NOW()
        WHERE r.id IN (
          SELECT id FROM campaign_sms_recipients
          WHERE batch_id = ${batch.id} AND status = 'pending'
          ORDER BY id
          LIMIT ${SMS_DISPATCH_CHUNK}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING r.id, r.engineer_id, r.phone
      `;

      if (claimed.length) {
        const ids = claimed.map((r) => r.engineer_id);
        const people = await sql`SELECT id, COALESCE(NULLIF(display_name, ''), name) AS name FROM engineers WHERE id = ANY(${ids})`;
        const nameById = new Map(people.map((p) => [p.id, p.name]));
        const configured = smsIsConfigured();
        let i = 0;
        async function worker() {
          while (i < claimed.length) {
            const r = claimed[i++];
            const msisdn = toSozuriMsisdn(r.phone);
            if (!msisdn) {
              await sql`UPDATE campaign_sms_recipients SET status = 'invalid_phone', error = 'No usable phone number' WHERE id = ${r.id}`;
              continue;
            }
            if (!configured) {
              await sql`UPDATE campaign_sms_recipients SET status = 'failed', error = 'SMS not configured on server' WHERE id = ${r.id}`;
              continue;
            }
            const text = batch.message.replace(/\[Name\]/gi, nameById.get(r.engineer_id) || "Engineer");
            try {
              const result = await sendViaSozuri(msisdn, text);
              const rec = result?.recipients?.[0];
              await sql`
                UPDATE campaign_sms_recipients
                SET status = 'sent', phone = ${msisdn}, provider_status = ${rec?.status || "accepted"}, provider_message_id = ${rec?.messageId || null}, sent_at = NOW()
                WHERE id = ${r.id}
              `;
            } catch (err) {
              await sql`UPDATE campaign_sms_recipients SET status = 'failed', phone = ${msisdn}, error = ${String(err.message || err).slice(0, 200)} WHERE id = ${r.id}`;
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(SMS_DISPATCH_CONCURRENCY, claimed.length) }, worker));
      }

      const [counts] = await sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS open,
               COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
               COUNT(*) FILTER (WHERE status = 'invalid_phone')::int AS invalid
        FROM campaign_sms_recipients WHERE batch_id = ${batch.id}
      `;
      await sql`
        UPDATE campaign_sms_batches
        SET sent_count = ${counts.sent}, failed_count = ${counts.failed}, invalid_count = ${counts.invalid},
            status = ${counts.open === 0 ? "done" : "sending"},
            completed_at = ${counts.open === 0 ? new Date() : null}
        WHERE id = ${batch.id}
      `;
      return res.status(200).json({
        batchId: batch.id,
        campaignId: batch.campaign_id,
        processed: claimed.length,
        remaining: counts.open,
        sent: counts.sent,
        failed: counts.failed,
        invalid: counts.invalid,
        total: batch.recipients_count,
        done: counts.open === 0,
      });
    }

    // ================= SSO BRIDGE =================
    // POST: hand back a valid Engineers Hub token for this member,
    // obtaining or rotating one as needed. GET: status only, no side
    // effects (the settings page and the app's "Linked accounts" row).
    if (action === "sso-login") {
      if (req.method !== "POST" && req.method !== "GET") {
        res.setHeader("Allow", "GET, POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      if (!ssoKey()) {
        return res.status(503).json({ code: "sso_not_configured", error: "Engineers Hub sign-in isn't set up yet." });
      }
      const [link] = await sql`
        SELECT * FROM sso_identities WHERE provider = 'engineershub' AND engineer_id = ${session.id}
      `;

      if (req.method === "GET") {
        return res.status(200).json({
          linked: !!link && link.status === "linked",
          status: link ? link.status : "none",
          origin: link ? link.origin : null,
          email: link ? link.external_email : null,
          expiresAt: link ? link.token_expires_at : null,
        });
      }

      const force = String(req.query.force || "") === "1";
      const now = Date.now();

      // A link we already know is broken isn't retried on every call —
      // that would hit his login rate limit on the member's behalf.
      // ?force=1 (the "Try again" button) is the way back in.
      if (link && link.status === "broken" && !force) {
        return res.status(409).json({ code: "sso_relink_required", error: "Your Engineers Hub account needs to be linked again." });
      }

      // 1. A cached token with a day or more left goes straight back.
      if (link && link.status === "linked" && link.token_enc && !force) {
        const remaining = new Date(link.token_expires_at).getTime() - now;
        const token = remaining > SSO_TOKEN_MIN_REMAINING_MS ? openSecret(link.token_enc) : null;
        if (token) {
          await sql`UPDATE sso_identities SET last_used_at = NOW() WHERE id = ${link.id}`;
          return res.status(200).json(ssoTokenPayload(token, link.token_expires_at, link.origin));
        }
      }

      // 2. Rotate the one we hold through his /auth/refresh.
      if (link && link.token_enc) {
        const current = openSecret(link.token_enc);
        const r = current ? await hisApi("/auth/refresh", { method: "POST", token: current }) : null;
        if (r && r.code) return ssoDown(res, r);
        if (r && r.ok && r.data.token) {
          const expiresAt = new Date(now + Number(r.data.expires_in_minutes || SSO_TOKEN_TTL_MINUTES) * 60000);
          await sql`
            UPDATE sso_identities
            SET token_enc = ${sealSecret(r.data.token)}, token_expires_at = ${expiresAt},
                status = 'linked', last_error = NULL, last_used_at = NOW()
            WHERE id = ${link.id}
          `;
          return res.status(200).json(ssoTokenPayload(r.data.token, expiresAt, link.origin));
        }
        // 401 here means revoked or long expired — fall through.
      }

      // 3. An account we registered: sign in again with the password we hold.
      if (link && link.credential_enc) {
        const password = openSecret(link.credential_enc);
        const r = password
          ? await hisApi("/auth/login", { method: "POST", body: { email: link.external_email, password, device: SSO_DEVICE_NAME } })
          : { ok: false, status: 0, data: {}, code: null };
        if (r.code) return ssoDown(res, r);
        if (r.status === 429) {
          return res.status(429).json({ code: "sso_rate_limited", error: "Too many sign-in attempts on Engineers Hub. Try again in a few minutes." });
        }
        if (r.ok && r.data.token) {
          const expiresAt = new Date(now + SSO_TOKEN_TTL_MINUTES * 60000);
          await sql`
            UPDATE sso_identities
            SET token_enc = ${sealSecret(r.data.token)}, token_expires_at = ${expiresAt},
                external_user_id = COALESCE(${r.data.user && r.data.user.id ? String(r.data.user.id) : null}, external_user_id),
                status = 'linked', last_error = NULL, last_used_at = NOW()
            WHERE id = ${link.id}
          `;
          return res.status(200).json(ssoTokenPayload(r.data.token, expiresAt, link.origin));
        }
        // The password we registered no longer works — it was changed on
        // his side. The member gets back in by signing in there once.
        await sql`
          UPDATE sso_identities SET status = 'broken', token_enc = NULL,
            last_error = ${`login ${r.status}: ${String(r.data.message || "").slice(0, 200)}`}
          WHERE id = ${link.id}
        `;
        return res.status(409).json({ code: "sso_relink_required", error: "Your Engineers Hub account needs to be linked again." });
      }

      // A linked account whose token can't be refreshed: same answer.
      if (link) {
        await sql`UPDATE sso_identities SET status = 'broken', token_enc = NULL, last_error = 'refresh rejected' WHERE id = ${link.id}`;
        return res.status(409).json({ code: "sso_relink_required", error: "Your Engineers Hub account needs to be linked again." });
      }

      // 4. First use: create their Engineers Hub account. This is the
      //    only path that writes to his platform, and it is one row.
      const email = String(session.email || "").trim().toLowerCase();
      if (!email) {
        return res.status(409).json({ code: "sso_email_required", error: "Add an email address to your profile first — Engineers Hub accounts need one." });
      }
      const password = randomBytes(32).toString("base64url"); // 43 chars, well past his 10 minimum
      const body = {
        name: String(session.display_name || session.name || "").slice(0, 120),
        email,
        password,
        account_type: "engineer",
        country_code: "KE",
        device: SSO_DEVICE_NAME,
      };
      if (SSO_REGISTER_WITH_PHONE && session.phone) body.phone = session.phone;
      const r = await hisApi("/auth/register", { method: "POST", body });
      if (r.code) return ssoDown(res, r);
      if (r.status === 201 && r.data.token) {
        const expiresAt = new Date(now + SSO_TOKEN_TTL_MINUTES * 60000);
        const hisUser = r.data.user || {};
        await sql`
          INSERT INTO sso_identities
            (engineer_id, provider, external_user_id, external_email, origin, credential_enc, token_enc, token_expires_at, status, last_used_at)
          VALUES
            (${session.id}, 'engineershub', ${hisUser.id ? String(hisUser.id) : null}, ${email}, 'registered',
             ${sealSecret(password)}, ${sealSecret(r.data.token)}, ${expiresAt}, 'linked', NOW())
          ON CONFLICT (provider, engineer_id) DO UPDATE SET
            external_user_id = EXCLUDED.external_user_id, external_email = EXCLUDED.external_email,
            origin = 'registered', credential_enc = EXCLUDED.credential_enc, token_enc = EXCLUDED.token_enc,
            token_expires_at = EXCLUDED.token_expires_at, status = 'linked', last_error = NULL, last_used_at = NOW()
        `;
        return res.status(200).json(ssoTokenPayload(r.data.token, expiresAt, "registered", { created: true }));
      }
      if (r.status === 422 && /already registered/i.test(String(r.data.message || ""))) {
        // Either a concurrent sso-login for this same member just won the
        // race to register (their row exists now — hand back its token),
        // or the member signed up on Engineers Hub themselves and needs
        // to link that account with their own password.
        const [raced] = await sql`
          SELECT token_enc, token_expires_at, origin FROM sso_identities
          WHERE provider = 'engineershub' AND engineer_id = ${session.id} AND status = 'linked'
        `;
        const token = raced && raced.token_enc ? openSecret(raced.token_enc) : null;
        if (token) return res.status(200).json(ssoTokenPayload(token, raced.token_expires_at, raced.origin));
        return res.status(409).json({
          code: "sso_account_exists",
          email,
          error: "You already have an Engineers Hub account with this email. Sign in to it once to link it.",
        });
      }
      return res.status(502).json({
        code: "sso_rejected",
        error: "Engineers Hub didn't accept the sign-in.",
        detail: r.data.message || r.data.errors || null,
      });
    }

    // A member who already has their own Engineers Hub account links it
    // by signing in to it once. The password goes to his /auth/login in
    // this one request and is never stored or logged; only the token is.
    if (action === "sso-link") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      if (!ssoKey()) {
        return res.status(503).json({ code: "sso_not_configured", error: "Engineers Hub sign-in isn't set up yet." });
      }
      const email = String((req.body && req.body.email) || "").trim().toLowerCase();
      const password = String((req.body && req.body.password) || "");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password) {
        return res.status(400).json({ error: "Enter the email and password of your Engineers Hub account." });
      }
      const r = await hisApi("/auth/login", { method: "POST", body: { email, password, device: SSO_DEVICE_NAME } });
      if (r.code) return ssoDown(res, r);
      if (r.status === 429) {
        return res.status(429).json({ code: "sso_rate_limited", error: "Too many sign-in attempts on Engineers Hub. Try again in a few minutes." });
      }
      if (!r.ok || !r.data.token) {
        return res.status(401).json({ code: "sso_invalid_credentials", error: "Engineers Hub didn't accept that email and password." });
      }
      const hisUser = r.data.user || {};
      const externalId = hisUser.id ? String(hisUser.id) : null;
      // One Engineers Hub account per member — never let two engineers
      // here share one identity there.
      if (externalId) {
        const [taken] = await sql`
          SELECT engineer_id FROM sso_identities
          WHERE provider = 'engineershub' AND external_user_id = ${externalId} AND engineer_id <> ${session.id}
        `;
        if (taken) {
          await hisApi("/auth/logout", { method: "POST", token: r.data.token });
          return res.status(409).json({ code: "sso_account_taken", error: "That Engineers Hub account is already linked to another member." });
        }
      }
      const expiresAt = new Date(Date.now() + SSO_TOKEN_TTL_MINUTES * 60000);
      await sql`
        INSERT INTO sso_identities
          (engineer_id, provider, external_user_id, external_email, origin, credential_enc, token_enc, token_expires_at, status, last_used_at)
        VALUES
          (${session.id}, 'engineershub', ${externalId}, ${email}, 'linked', NULL, ${sealSecret(r.data.token)}, ${expiresAt}, 'linked', NOW())
        ON CONFLICT (provider, engineer_id) DO UPDATE SET
          external_user_id = EXCLUDED.external_user_id, external_email = EXCLUDED.external_email,
          origin = 'linked', credential_enc = NULL, token_enc = EXCLUDED.token_enc,
          token_expires_at = EXCLUDED.token_expires_at, status = 'linked', last_error = NULL, last_used_at = NOW()
      `;
      return res.status(200).json(ssoTokenPayload(r.data.token, expiresAt, "linked"));
    }

    // Disconnect. The token is revoked on his side too (best effort). An
    // account we registered keeps its sealed password so a later
    // sso-login can pick it back up — deleting that would strand an
    // Engineers Hub account whose password nobody knows.
    if (action === "sso-unlink") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;
      const [link] = await sql`
        SELECT * FROM sso_identities WHERE provider = 'engineershub' AND engineer_id = ${session.id}
      `;
      if (!link) return res.status(200).json({ ok: true, linked: false });
      const token = link.token_enc && ssoKey() ? openSecret(link.token_enc) : null;
      if (token) await hisApi("/auth/logout", { method: "POST", token });
      if (link.origin === "registered") {
        await sql`UPDATE sso_identities SET token_enc = NULL, token_expires_at = NULL, status = 'unlinked', last_used_at = NOW() WHERE id = ${link.id}`;
      } else {
        await sql`DELETE FROM sso_identities WHERE id = ${link.id}`;
      }
      return res.status(200).json({ ok: true, linked: false });
    }

    return res.status(400).json({
      error: "Unknown action. Use one of: login, logout, logout-all, me, update-profile, consent, save-email, support, upload-photo, work-experience, education, skills, directory, connections, follows, feed, jobs, profile, dashboard, toggle-open-to-work, conversations, messages, typing, posts, upload-post-image, upload-post-video, react-post, post-reactors, save-post, pin-post, report-post, comments, notifications, admin-login, admin-logout, admin-me, admin-engineers, admin-import, admin-email-recipients, admin-send-email, admin-send-event-email, admin-email-logs, admin-email-templates, admin-support, admin-support-reply, elections, campaigns, upload-campaign-photo, ballot, vote, election-results, campaign-sms-recipients, campaign-sms, campaign-sms-batch, campaign-sms-dispatch, sso-login, sso-link, sso-unlink.",
    });
  } catch (err) {
    return sendError(res, err);
  }
}
