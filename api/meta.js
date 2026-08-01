import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";
import { getElectionStatusPayload } from "./_config.js";

// GET /api/audit-log       -> rewritten to /api/meta?type=audit
// GET /api/election-status -> rewritten to /api/meta?type=status
//
// Combined into one file (was audit-log.js + election-status.js) to stay
// under Vercel's serverless function count limit on the Hobby plan — see
// README "Serverless function count". Browser-facing URLs are unchanged.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const { type } = req.query;

  try {
    if (type === "status") {
      return res.status(200).json(getElectionStatusPayload());
    }

    if (type === "audit") {
      const sql = getSql();
      const rows = await sql`
        SELECT a.id, a.action, a.timestamp, a.user_ip, a.engineer_id,
               e.iek_number, e.name
        FROM audit_log a
        LEFT JOIN engineers e ON e.id = a.engineer_id
        ORDER BY a.timestamp DESC
        LIMIT 200
      `;
      return res.status(200).json({ entries: rows });
    }

    return res.status(400).json({ error: "type must be 'status' or 'audit'." });
  } catch (err) {
    return sendError(res, err);
  }
}
