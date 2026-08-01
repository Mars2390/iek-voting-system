import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";
import { getElectionPhase } from "./_config.js";

// PUT    /api/engineers/:id -> update name/phone and/or cast a vote
// DELETE /api/engineers/:id -> remove an engineer
//
// This file is deployed at /api/engineer (no brackets). vercel.json rewrites
// /api/engineers/:id -> /api/engineer?id=:id so the browser-facing URL stays
// the same; see the note in vercel.json for why this replaced a bracket-
// folder dynamic route ([id].js), which 404'd in production.
//
// NOTE: contact_status is no longer settable here — POST /api/contact-calls
// is the single place that changes it now, so every status change (whether
// from the quick per-row dropdown or the full "Log Call" form) always
// produces a matching contact_calls row and call_count increment. Remarks
// similarly moved to POST /api/remarks (authored, timestamped, one row per
// note) — the `remarks` column here is frozen legacy text from before that
// table existed and is no longer written to by the app.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const engineerId = Number(req.query.id);

  if (!Number.isInteger(engineerId)) {
    return res.status(400).json({ error: "Invalid engineer id." });
  }

  try {
    const [existing] = await sql`SELECT * FROM engineers WHERE id = ${engineerId}`;
    if (!existing) {
      return res.status(404).json({ error: "Engineer not found." });
    }

    const ip = getClientIp(req);

    if (req.method === "PUT") {
      const { name, phone, voted } = req.body || {};

      // Election integrity: once cast, a vote cannot be reversed through
      // this endpoint. (If test votes need clearing before election day,
      // use POST /api/reset-votes — a deliberate bulk/admin action, not a
      // per-row undo click.)
      if (voted === false && existing.voted === true) {
        return res.status(403).json({
          error: "Votes cannot be reversed once cast. If this was test data, use Reset All Votes before election day.",
        });
      }

      const nextName = name !== undefined ? name : existing.name;
      const nextPhone = phone !== undefined ? phone : existing.phone;
      const nextVoted = voted !== undefined ? Boolean(voted) : existing.voted;
      const isCastingNewVote = voted === true && !existing.voted;

      // Only the act of CASTING a vote is time-gated. Editing name/phone
      // works at any time — that's setup/admin work, not "casting a ballot."
      if (isCastingNewVote) {
        const phase = getElectionPhase();
        if (phase !== "live") {
          const message = phase === "before"
            ? "Voting has not started yet."
            : "Voting has closed.";
          return res.status(403).json({ error: message, phase });
        }
      }

      const [updated] = await sql`
        UPDATE engineers
        SET name = ${nextName},
            phone = ${nextPhone},
            voted = ${nextVoted},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${engineerId}
        RETURNING id, iek_number, name, phone, voted, remarks, contact_status,
                  last_contacted_at, call_count, confirmed_vote, created_at, updated_at
      `;

      if (isCastingNewVote) {
        await sql`INSERT INTO votes (engineer_id, voter_ip) VALUES (${engineerId}, ${ip})`;
        await logAudit(sql, "VOTE", engineerId, ip);
      } else {
        await logAudit(sql, "UPDATE", engineerId, ip);
      }

      return res.status(200).json({ engineer: updated });
    }

    if (req.method === "DELETE") {
      // Log the audit entry before deleting (while the FK is still valid).
      // ON DELETE SET NULL on audit_log.engineer_id means this row survives
      // the delete below, just with engineer_id nulled out afterward.
      await logAudit(sql, "DELETE", engineerId, ip);
      await sql`DELETE FROM engineers WHERE id = ${engineerId}`;

      return res.status(200).json({
        success: true,
        deleted: { id: existing.id, iek_number: existing.iek_number, name: existing.name },
      });
    }

    res.setHeader("Allow", "PUT, DELETE, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
