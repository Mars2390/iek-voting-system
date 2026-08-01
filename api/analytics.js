import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

const ALL_STATUSES = ["pending", "confirmed", "no_answer", "busy_declined", "follow_up", "not_reachable"];

// GET /api/analytics -> data for the Analytics dashboard section
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  try {
    const sql = getSql();

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
  } catch (err) {
    return sendError(res, err);
  }
}
