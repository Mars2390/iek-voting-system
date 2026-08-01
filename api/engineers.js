import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// GET  /api/engineers  -> list all engineers
// POST /api/engineers  -> register a new engineer
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();

  try {
    if (req.method === "GET") {
      const rows = await sql`
        SELECT e.id, e.iek_number, e.name, e.phone, e.voted, e.remarks,
               e.created_at, e.updated_at, v.voted_at
        FROM engineers e
        LEFT JOIN LATERAL (
          SELECT voted_at FROM votes WHERE engineer_id = e.id ORDER BY voted_at DESC LIMIT 1
        ) v ON true
        ORDER BY e.created_at ASC
      `;
      return res.status(200).json({ engineers: rows });
    }

    if (req.method === "POST") {
      const { iekNumber, name, phone, remarks } = req.body || {};

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
        RETURNING id, iek_number, name, phone, voted, remarks, created_at, updated_at
      `;

      await logAudit(sql, "CREATE", engineer.id, getClientIp(req));

      return res.status(201).json({ engineer });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
