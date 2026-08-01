import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";
import { getElectionPhase } from "./_config.js";

// GET    /api/engineers        -> list all engineers
// POST   /api/engineers        -> register a new engineer
// PUT    /api/engineers/:id    -> update name/phone, or cast a vote (rewritten to ?id=)
// DELETE /api/engineers/:id    -> delete an engineer (rewritten to ?id=)
//
// Combined into one file (was engineers.js + engineer.js) to stay under
// Vercel's serverless function count limit on the Hobby plan — see
// README "Serverless function count" for why this project hit that wall
// and consolidated several endpoints this way. Browser-facing URLs are
// unchanged; vercel.json rewrites /api/engineers/:id -> /api/engineers?id=:id.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const { id } = req.query;

  try {
    // ---------------------------------------------------------
    // Collection endpoints: /api/engineers (no id)
    // ---------------------------------------------------------
    if (id === undefined) {
      if (req.method === "GET") {
        const rows = await sql`
          SELECT e.id, e.iek_number, e.name, e.phone, e.voted, e.remarks,
                 e.contact_status, e.last_contacted_at, e.call_count, e.confirmed_vote,
                 -- Live-computed, not the stored needs_followup column — one of the
                 -- criteria is time-based ("no remark in 2 days") and would go stale
                 -- if only checked when a row is written. See api/reports.js (?type=urgent).
                 (
                   NOT e.voted AND e.contact_status <> 'confirmed' AND (
                     e.call_count >= 3
                     OR e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')
                     OR NOT EXISTS (
                       SELECT 1 FROM remarks r2 WHERE r2.engineer_id = e.id AND r2.created_at > NOW() - INTERVAL '2 days'
                     )
                   )
                 ) AS needs_followup,
                 e.created_at, e.updated_at, v.voted_at,
                 lr.author AS last_remark_author, lr.remark AS last_remark_text, lr.created_at AS last_remark_at
          FROM engineers e
          LEFT JOIN LATERAL (
            SELECT voted_at FROM votes WHERE engineer_id = e.id ORDER BY voted_at DESC LIMIT 1
          ) v ON true
          LEFT JOIN LATERAL (
            SELECT author, remark, created_at FROM remarks WHERE engineer_id = e.id ORDER BY created_at DESC LIMIT 1
          ) lr ON true
          ORDER BY e.created_at ASC
        `;
        return res.status(200).json({ engineers: rows });
      }

      if (req.method === "POST") {
        const { name, phone, remarks } = req.body || {};
        // Uppercase for matching accuracy — see api/import.js for why
        // (keeps manually-added and CSV-imported IEK numbers comparable).
        const iekNumber = (req.body?.iekNumber || "").trim().toUpperCase();

        // Phone is intentionally optional here (the DB column is nullable) —
        // sometimes you need to register someone before you have their number.
        if (!iekNumber || !name) {
          return res.status(400).json({ error: "iekNumber and name are required." });
        }

        const existing = await sql`SELECT id FROM engineers WHERE iek_number = ${iekNumber}`;
        if (existing.length > 0) {
          return res.status(409).json({ error: "An engineer with this IEK number already exists." });
        }

        const [engineer] = await sql`
          INSERT INTO engineers (iek_number, name, phone, remarks)
          VALUES (${iekNumber}, ${name}, ${phone || null}, ${remarks || null})
          RETURNING id, iek_number, name, phone, voted, remarks, contact_status, last_contacted_at, call_count, confirmed_vote, created_at, updated_at
        `;

        await logAudit(sql, "CREATE", engineer.id, getClientIp(req));

        return res.status(201).json({ engineer });
      }

      res.setHeader("Allow", "GET, POST, OPTIONS");
      return res.status(405).json({ error: `Method ${req.method} not allowed.` });
    }

    // ---------------------------------------------------------
    // Single-item endpoints: /api/engineers/:id
    // ---------------------------------------------------------
    const engineerId = Number(id);
    if (!Number.isInteger(engineerId)) {
      return res.status(400).json({ error: "Invalid engineer id." });
    }

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
