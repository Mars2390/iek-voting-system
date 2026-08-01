import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

// GET /api/urgent -> engineers needing a follow-up call, computed LIVE
// (not from the stored needs_followup column — one of the criteria is
// time-based ["no remark in the last 2 days"], which would silently go
// stale if only checked at write time). Flagged when NOT voted, not yet
// confirmed, and at least one of:
//   - 3+ calls logged already
//   - latest contact status is follow_up / no_answer / not_reachable
//   - no remark logged in the last 2 days
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  try {
    const sql = getSql();
    const rows = await sql`
      SELECT
        e.id, e.iek_number, e.name, e.phone, e.voted, e.contact_status,
        e.call_count, e.last_contacted_at,
        (e.call_count >= 3) AS reason_many_calls,
        (e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')) AS reason_status,
        NOT EXISTS (
          SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.created_at > NOW() - INTERVAL '2 days'
        ) AS reason_stale_remarks
      FROM engineers e
      WHERE NOT e.voted
        AND e.contact_status <> 'confirmed'
        AND (
          e.call_count >= 3
          OR e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')
          OR NOT EXISTS (
            SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.created_at > NOW() - INTERVAL '2 days'
          )
        )
      ORDER BY e.call_count DESC, e.last_contacted_at ASC NULLS FIRST
    `;

    return res.status(200).json({ urgent: rows, count: rows.length });
  } catch (err) {
    return sendError(res, err);
  }
}
