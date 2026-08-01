import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

export const VALID_CALL_STATUSES = ["pending", "confirmed", "no_answer", "busy_declined", "follow_up", "not_reachable"];

// Recomputes needs_followup for one engineer using the same live rule as
// api/urgent.js — call this after anything that could change the inputs
// (call logged, vote cast). Not relied on for reads (those recompute live),
// this just keeps the stored column from being wildly out of date.
async function refreshNeedsFollowUp(sql, engineerId) {
  await sql`
    UPDATE engineers e SET needs_followup = (
      NOT e.voted AND e.contact_status <> 'confirmed' AND (
        e.call_count >= 3
        OR e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')
        OR NOT EXISTS (
          SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.created_at > NOW() - INTERVAL '2 days'
        )
      )
    )
    WHERE e.id = ${engineerId}
  `;
}

// GET  /api/contact-calls?engineerId=X -> call history for one engineer
// GET  /api/contact-calls              -> most recent 500 calls, all engineers
// POST /api/contact-calls              -> log a call
//   body: { engineerId, callerName, callStatus, notes? }
//   This is the single place that changes engineers.contact_status —
//   the quick per-row dropdown AND the full "Log Call" form both call this,
//   so call history is always complete regardless of which UI path was used.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();

  try {
    if (req.method === "GET") {
      const { engineerId } = req.query;

      if (engineerId) {
        const id = Number(engineerId);
        if (!Number.isInteger(id)) {
          return res.status(400).json({ error: "Invalid engineerId." });
        }
        const rows = await sql`
          SELECT id, engineer_id, caller_name, call_status, notes, called_at
          FROM contact_calls
          WHERE engineer_id = ${id}
          ORDER BY called_at DESC
        `;
        return res.status(200).json({ calls: rows });
      }

      const rows = await sql`
        SELECT c.id, c.engineer_id, c.caller_name, c.call_status, c.notes, c.called_at,
               e.name AS engineer_name, e.iek_number
        FROM contact_calls c
        LEFT JOIN engineers e ON e.id = c.engineer_id
        ORDER BY c.called_at DESC
        LIMIT 500
      `;
      return res.status(200).json({ calls: rows });
    }

    if (req.method === "POST") {
      const { engineerId, callerName, callStatus, notes } = req.body || {};
      const id = Number(engineerId);

      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "engineerId is required and must be a number." });
      }
      if (!callerName || !callerName.trim()) {
        return res.status(400).json({ error: "callerName is required — identify who is logging this call." });
      }
      if (!VALID_CALL_STATUSES.includes(callStatus)) {
        return res.status(400).json({ error: `callStatus must be one of: ${VALID_CALL_STATUSES.join(", ")}` });
      }

      const [engineer] = await sql`SELECT id FROM engineers WHERE id = ${id}`;
      if (!engineer) {
        return res.status(404).json({ error: "Engineer not found." });
      }

      const ip = getClientIp(req);

      const [call] = await sql`
        INSERT INTO contact_calls (engineer_id, caller_name, call_status, notes)
        VALUES (${id}, ${callerName.trim()}, ${callStatus}, ${notes || null})
        RETURNING id, engineer_id, caller_name, call_status, notes, called_at
      `;

      await sql`
        UPDATE engineers
        SET contact_status = ${callStatus},
            last_contacted_at = CURRENT_TIMESTAMP,
            call_count = call_count + 1,
            confirmed_vote = ${callStatus === "confirmed"},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
      `;
      await refreshNeedsFollowUp(sql, id);
      await logAudit(sql, `CALL_${callStatus.toUpperCase()}`, id, ip);

      return res.status(201).json({ call });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
