import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

const ALL_STATUSES = ["pending", "confirmed", "no_answer", "busy_declined", "follow_up", "not_reachable"];

// GET /api/urgent    -> rewritten to /api/reports?type=urgent
// GET /api/analytics -> rewritten to /api/reports?type=analytics
//
// Combined into one file (was urgent.js + analytics.js) to stay under
// Vercel's serverless function count limit on the Hobby plan — see README
// "Serverless function count". Browser-facing URLs are unchanged.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const { type } = req.query;

  try {
    const sql = getSql();

    if (type === "urgent") {
      // Computed LIVE, not from the stored needs_followup column — one of
      // the criteria is time-based ("no remark in the last 2 days"), which
      // would silently go stale if only checked at write time.
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
    }

    if (type === "analytics") {
      const statusRows = await sql`
        SELECT contact_status, COUNT(*)::int AS count
        FROM engineers
        GROUP BY contact_status
      `;
      const statusCounts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
      for (const row of statusRows) {
        if (row.contact_status in statusCounts) statusCounts[row.contact_status] = row.count;
      }

      const dailyCalls = await sql`
        SELECT TO_CHAR(called_at, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
        FROM contact_calls
        WHERE called_at > NOW() - INTERVAL '7 days'
        GROUP BY date
        ORDER BY date ASC
      `;

      const dailyConfirmations = await sql`
        SELECT TO_CHAR(called_at, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
        FROM contact_calls
        WHERE call_status = 'confirmed' AND called_at > NOW() - INTERVAL '7 days'
        GROUP BY date
        ORDER BY date ASC
      `;

      const dailyVotes = await sql`
        SELECT TO_CHAR(voted_at, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
        FROM votes
        WHERE voted_at > NOW() - INTERVAL '7 days'
        GROUP BY date
        ORDER BY date ASC
      `;

      const [{ total, voted, urgent_count }] = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM engineers) AS total,
          (SELECT COUNT(*)::int FROM engineers WHERE voted) AS voted,
          (SELECT COUNT(*)::int FROM engineers e
            WHERE NOT e.voted AND e.contact_status <> 'confirmed' AND (
              e.call_count >= 3
              OR e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')
              OR NOT EXISTS (SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.created_at > NOW() - INTERVAL '2 days')
            )
          ) AS urgent_count
      `;

      return res.status(200).json({
        total,
        voted,
        notVoted: total - voted,
        turnout: total > 0 ? Math.round((voted / total) * 100) : 0,
        urgentCount: urgent_count,
        statusCounts,
        dailyCalls,
        dailyConfirmations,
        dailyVotes,
      });
    }

    return res.status(400).json({ error: "type must be 'urgent' or 'analytics'." });
  } catch (err) {
    return sendError(res, err);
  }
}
