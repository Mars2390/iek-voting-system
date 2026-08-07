import { randomBytes } from "node:crypto";
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
// work-experience, education, skills, directory, connections, feed,
// jobs, dashboard.
//
// KNOWN GAP, documented rather than hidden (same convention as the
// voting system's own README "Security note" and the original login
// comment below): a membership number is not a secret — anyone who can
// guess or enumerate one gets full view+edit access to that person's
// profile. Session tokens are long random values; the weak point is
// specifically the login step, not what happens after it.

const SESSION_DAYS = 30;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB

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
    SELECT s.id AS session_id, s.expires_at, e.*
    FROM sessions s
    JOIN engineers e ON e.id = s.engineer_id
    WHERE s.token = ${token}
  `;
  if (!session || new Date(session.expires_at) < new Date()) {
    res.status(401).json({ error: "Your session has expired. Please log in again." });
    return null;
  }
  sql`UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ${session.session_id}`.catch(() => {});
  sql`UPDATE engineers SET last_active = CURRENT_TIMESTAMP WHERE id = ${session.id}`.catch(() => {});
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
    verified: true,
  };
}

// Public-facing view of someone else's profile: no phone number.
// Email/LinkedIn/GitHub/portfolio ARE shown — those are fields the
// person explicitly filled in to be found professionally; phone comes
// from the IEK voter register and was never meant for public display.
function publicEngineer(e) {
  const priv = privateEngineer(e);
  delete priv.phone;
  return priv;
}

async function logActivity(sql, engineerId, actionType, description) {
  await sql`
    INSERT INTO activity_feed (engineer_id, action_type, description)
    VALUES (${engineerId}, ${actionType}, ${description})
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

      const { displayName, membershipNumber } = req.body || {};
      const digits = digitsOnly(membershipNumber);
      if (!digits) {
        return res.status(400).json({ error: "Enter your membership number." });
      }

      const [engineer] = await sql`
        SELECT * FROM engineers
        WHERE regexp_replace(iek_number, '[^0-9]', '', 'g') = ${digits}
      `;
      if (!engineer) {
        return res.status(404).json({
          error: "We couldn't find that membership number. Check the digits and try again.",
        });
      }

      const cleanName = String(displayName || "").trim().slice(0, 150);
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
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
        VALUES (${token}, ${engineer.id}, ${expiresAt.toISOString()})
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
        return res.status(413).json({ error: "Image is too large. Keep it under 5MB." });
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
               OR company ILIKE ${like} OR iek_number ILIKE ${like})
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
          iekNumber: e.iek_number,
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
      if (req.method === "GET") {
        const discipline = String(req.query.discipline || "").trim();
        const q = String(req.query.q || "").trim();
        const like = `%${q}%`;
        const rows = await sql`
          SELECT j.*, e.display_name AS poster_name, e.name AS poster_registered_name
          FROM jobs j
          LEFT JOIN engineers e ON e.id = j.posted_by
          WHERE j.is_active = TRUE
            AND (${discipline}::text = '' OR j.discipline = ${discipline})
            AND (${q}::text = '' OR j.title ILIKE ${like} OR j.company_name ILIKE ${like})
          ORDER BY j.created_at DESC
          LIMIT 50
        `;
        return res.status(200).json({
          jobs: rows.map((j) => ({
            id: j.id,
            title: j.title,
            companyName: j.company_name,
            location: j.location,
            jobType: j.job_type,
            discipline: j.discipline,
            description: j.description,
            applyUrl: j.apply_url,
            applyEmail: j.apply_email,
            postedBy: j.poster_name || j.poster_registered_name || "Engineer Hub member",
            postedById: j.posted_by,
            createdAt: j.created_at,
          })),
        });
      }

      const session = await requireSession(sql, req, res);
      if (!session) return;

      if (req.method === "POST") {
        const b = req.body || {};
        if (!b.title || !b.companyName || !b.description) {
          return res.status(400).json({ error: "Title, company, and description are required." });
        }
        if (!b.applyUrl && !b.applyEmail) {
          return res.status(400).json({ error: "Add a way to apply — a URL or an email address." });
        }
        const [row] = await sql`
          INSERT INTO jobs (posted_by, title, company_name, location, job_type, discipline, description, apply_url, apply_email)
          VALUES (${session.id}, ${b.title}, ${b.companyName}, ${b.location || null}, ${b.jobType || null}, ${b.discipline || null}, ${b.description}, ${b.applyUrl || null}, ${b.applyEmail || null})
          RETURNING *
        `;
        await logActivity(sql, session.id, "job_posted", `${session.display_name || session.name} posted a job: ${b.title} at ${b.companyName}`);
        return res.status(201).json({ job: row });
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

      const [experience, education, skills, connectionRow] = await Promise.all([
        sql`SELECT * FROM work_experience WHERE engineer_id = ${id} ORDER BY is_current DESC, start_date DESC NULLS LAST`,
        sql`SELECT * FROM education WHERE engineer_id = ${id} ORDER BY end_year DESC NULLS FIRST`,
        sql`SELECT * FROM skills WHERE engineer_id = ${id} ORDER BY skill_name ASC`,
        id === session.id
          ? Promise.resolve([null])
          : sql`SELECT id, status, requester_id FROM connections WHERE (requester_id = ${session.id} AND addressee_id = ${id}) OR (requester_id = ${id} AND addressee_id = ${session.id})`,
      ]);

      const isSelf = id === session.id;
      const conn = connectionRow[0];

      return res.status(200).json({
        engineer: isSelf ? privateEngineer(target) : publicEngineer(target),
        isSelf,
        connectionStatus: isSelf ? null : conn ? conn.status : "none",
        connectionId: conn ? conn.id : null,
        isIncomingRequest: conn && conn.status === "pending" && conn.requester_id !== session.id,
        experience,
        education,
        skills,
      });
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

    return res.status(400).json({
      error: "Unknown action. Use one of: login, logout, logout-all, me, update-profile, upload-photo, work-experience, education, skills, directory, connections, feed, jobs, profile, dashboard.",
    });
  } catch (err) {
    return sendError(res, err);
  }
}
