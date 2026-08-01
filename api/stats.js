import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

// GET /api/stats -> total, voted, notVoted, turnout %
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  try {
    const sql = getSql();
    const [row] = await sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE voted)::int AS voted,
        COUNT(*) FILTER (WHERE NOT voted)::int AS not_voted,
        COUNT(*) FILTER (WHERE contact_status = 'pending')::int AS not_contacted,
        -- Same live formula as api/reports.js (?type=urgent) and api/engineers.js —
        -- kept in sync deliberately so the dashboard card, the Analytics section,
        -- and the Urgent list always agree on this number.
        COUNT(*) FILTER (
          WHERE NOT voted AND contact_status <> 'confirmed' AND (
            call_count >= 3
            OR contact_status IN ('follow_up', 'no_answer', 'not_reachable')
            OR NOT EXISTS (
              SELECT 1 FROM remarks r WHERE r.engineer_id = engineers.id AND r.created_at > NOW() - INTERVAL '2 days'
            )
          )
        )::int AS needs_follow_up
      FROM engineers
    `;

    const total = row.total;
    const voted = row.voted;
    const notVoted = row.not_voted;
    const turnout = total > 0 ? Math.round((voted / total) * 100) : 0;

    return res.status(200).json({
      total,
      voted,
      notVoted,
      turnout,
      needsFollowUp: row.needs_follow_up,
      notContacted: row.not_contacted,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
