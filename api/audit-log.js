import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

// GET /api/audit-log -> recent audit trail entries (newest first)
// Read-only endpoint; not gated by the election window.
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
      SELECT a.id, a.action, a.timestamp, a.user_ip, a.engineer_id,
             e.iek_number, e.name
      FROM audit_log a
      LEFT JOIN engineers e ON e.id = a.engineer_id
      ORDER BY a.timestamp DESC
      LIMIT 200
    `;
    return res.status(200).json({ entries: rows });
  } catch (err) {
    return sendError(res, err);
  }
}
