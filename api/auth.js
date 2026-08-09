import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { put } from "@vercel/blob";
import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

// The Engineer Hub member API. One file, many `?action=` values — NOT
// split into more files because this project sits at the Vercel Hobby
// plan's 12-function ceiling (see README "Serverless function count").
// Splitting this further would silently 404 the newest endpoints with
// no build error, exactly as documented there.
//
// Actions: login, logout, me, update-profile, upload-photo,
// work-experience, education, skills, directory, connections, follows,
// feed, jobs, profile, dashboard, toggle-open-to-work, conversations,
// messages, admin-login, admin-logout, admin-me, admin-engineers, admin-import.
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
const REACTION_TYPES = ["like", "love", "celebrate", "laugh", "wow", "sad", "angry"];
const TYPING_WINDOW_MS = 8000;

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
  sql`UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ${session.session_id}`.catch(() => {});
  sql`UPDATE engineers SET last_active = CURRENT_TIMESTAMP WHERE id = ${session.id}`.catch(() => {});
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

function computeProfileCompletion(e, counts) {
  const checks = [
    !!e.bio,
    !!e.title,
    !!e.company,
    !!e.location,
    !!e.discipline,
    !!e.experience_years,
    !!e.profile_photo,
    counts.experience > 0,
    counts.education > 0,
    counts.skills > 0,
  ];
  const done = checks.filter(Boolean).length;
  return Math.round((done / checks.length) * 100);
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const { action } = req.query;

  try {
    // =========================================================
    // AUTH
    // =========================================================
    if (action === "login") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }

      const { displayName, membershipNumber, pin } = req.body || {};
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
        await sql`
          UPDATE engineers SET pin_hash = ${hashPin(pin)}, pin_set_at = CURRENT_TIMESTAMP, failed_pin_attempts = 0
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

      if (req.method === "DELETE") {
        const id = Number(req.query.id || (req.body || {}).id);
        await sql`DELETE FROM skills WHERE id = ${id} AND engineer_id = ${session.id}`;
        return res.status(200).json({ success: true });
      }

      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
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
               COUNT(*) OVER() AS total_count
        FROM engineers
        WHERE (${q}::text = '' OR display_name ILIKE ${like} OR name ILIKE ${like}
               OR company ILIKE ${like} OR iek_number ILIKE ${like} OR title ILIKE ${like})
          AND (${discipline}::text = '' OR discipline = ${discipline})
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
      // duplicate rows for "who viewed your profile".
      if (!isSelf) {
        sql`
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
               (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND is_read = FALSE AND sender_id != ${session.id}) AS unread_count
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
        })),
        totalUnread: rows.reduce((sum, r) => sum + Number(r.unread_count), 0),
      });
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
          SELECT id, sender_id, content, is_read, created_at, edited_at FROM messages
          WHERE conversation_id = ${conv.id} ORDER BY created_at ASC LIMIT 200
        `;
        sql`UPDATE messages SET is_read = TRUE WHERE conversation_id = ${conv.id} AND sender_id != ${session.id} AND is_read = FALSE`.catch(() => {});

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
        if (!otherId || otherId === session.id) return res.status(400).json({ error: "Invalid recipient." });
        if (!content) return res.status(400).json({ error: "Message can't be empty." });

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
          INSERT INTO messages (conversation_id, sender_id, content) VALUES (${conv.id}, ${session.id}, ${content}) RETURNING *
        `;
        // Sending clears "typing" — otherwise the indicator can linger
        // up to TYPING_WINDOW_MS after the message already arrived.
        await sql`UPDATE conversations SET typing_by = NULL, typing_until = NULL WHERE id = ${conv.id}`;
        await notify(sql, otherId, session.id, "message", "conversation", conv.id);
        return res.status(201).json({ conversationId: conv.id, message: { id: message.id, senderId: message.sender_id, content: message.content, isRead: message.is_read, createdAt: message.created_at, isEdited: false, isMine: true } });
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
        const rows = await sql`
          SELECT n.id, n.type, n.target_type, n.target_id, n.is_read, n.created_at,
                 a.id AS actor_id, a.display_name, a.name, a.profile_photo
          FROM notifications n JOIN engineers a ON a.id = n.actor_id
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

      const [expCount, eduCount, skillCount, connCount, pendingCount, suggestions, recent] = await Promise.all([
        sql`SELECT COUNT(*) FROM work_experience WHERE engineer_id = ${session.id}`,
        sql`SELECT COUNT(*) FROM education WHERE engineer_id = ${session.id}`,
        sql`SELECT COUNT(*) FROM skills WHERE engineer_id = ${session.id}`,
        sql`SELECT COUNT(*) FROM connections WHERE status = 'accepted' AND (requester_id = ${session.id} OR addressee_id = ${session.id})`,
        sql`SELECT COUNT(*) FROM connections WHERE addressee_id = ${session.id} AND status = 'pending'`,
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
        profileCompletion: completion,
        connectionsCount: Number(connCount[0].count),
        pendingRequestsCount: Number(pendingCount[0].count),
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

    return res.status(400).json({
      error: "Unknown action. Use one of: login, logout, logout-all, me, update-profile, upload-photo, work-experience, education, skills, directory, connections, follows, feed, jobs, profile, dashboard, toggle-open-to-work, conversations, messages, typing, posts, upload-post-image, upload-post-video, react-post, post-reactors, save-post, pin-post, report-post, comments, notifications, admin-login, admin-logout, admin-me, admin-engineers, admin-import.",
    });
  } catch (err) {
    return sendError(res, err);
  }
}
