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
        COUNT(*) FILTER (WHERE NOT voted)::int AS not_voted
      FROM engineers
    `;

    const total = row.total;
    const voted = row.voted;
    const notVoted = row.not_voted;
    const turnout = total > 0 ? Math.round((voted / total) * 100) : 0;

    return res.status(200).json({ total, voted, notVoted, turnout });
  } catch (err) {
    return sendError(res, err);
  }
}
