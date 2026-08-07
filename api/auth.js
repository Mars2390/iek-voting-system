import { randomBytes } from "node:crypto";
import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

// POST /api/auth?action=login           -> { displayName, membershipNumber } in body
// POST /api/auth?action=logout          -> requires session token
// GET  /api/auth?action=me              -> requires session token
// POST /api/auth?action=update-profile  -> requires session token, { displayName, discipline, company }
//
// Membership-number-only login: no password. The number is matched on
// digits alone (any format — "M.1234", "m1234", "1234" all match the
// same record), verified unique across the live 317-row register before
// shipping this — see migrations/002_login_system.sql. The DISPLAY name
// typed at login is never used to gate access, only to greet the user;
// it's stored once (first login) and after that only changes via the
// "update-profile" action, so a mistyped name at login doesn't keep
// clobbering a corrected one on every subsequent login.
//
// KNOWN GAP, documented rather than hidden (same convention as the
// voting system's own README "Security note"): a membership number is
// not a secret. Anyone who can guess or enumerate one gets full
// view+edit access to that person's profile and phone number. Session
// tokens themselves are long random values, not guessable — the weak
// point is specifically the login step, not what happens after it.

const SESSION_DAYS = 30;

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
  return session;
}

function publicEngineer(e) {
  return {
    id: e.id,
    iekNumber: e.iek_number,
    displayName: e.display_name || e.name,
    registeredName: e.name,
    phone: e.phone,
    discipline: e.discipline,
    company: e.company,
    profilePhoto: e.profile_photo,
    lastLogin: e.last_login,
    verified: true, // matched against the official IEK register by definition
  };
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const { action } = req.query;

  try {
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

      const [updated] = await sql`
        UPDATE engineers
        SET last_login = CURRENT_TIMESTAMP,
            display_name = COALESCE(NULLIF(display_name, ''), NULLIF(${cleanName}, ''))
        WHERE id = ${engineer.id}
        RETURNING *
      `;

      await sql`
        INSERT INTO sessions (token, engineer_id, expires_at)
        VALUES (${token}, ${engineer.id}, ${expiresAt.toISOString()})
      `;

      return res.status(200).json({ token, engineer: publicEngineer(updated) });
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

    if (action === "me") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return; // response already sent
      return res.status(200).json({ engineer: publicEngineer(session) });
    }

    if (action === "update-profile") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: "Method not allowed." });
      }
      const session = await requireSession(sql, req, res);
      if (!session) return;

      const { displayName, discipline, company } = req.body || {};
      const [updated] = await sql`
        UPDATE engineers
        SET display_name = ${String(displayName || "").trim().slice(0, 150) || null},
            discipline = ${String(discipline || "").trim().slice(0, 100) || null},
            company = ${String(company || "").trim().slice(0, 150) || null},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${session.id}
        RETURNING *
      `;
      return res.status(200).json({ engineer: publicEngineer(updated) });
    }

    return res.status(400).json({ error: "action must be one of: login, logout, me, update-profile." });
  } catch (err) {
    return sendError(res, err);
  }
}
