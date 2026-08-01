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
        SELECT id, iek_number, name, phone, voted, remarks, created_at, updated_at
        FROM engineers
        ORDER BY created_at ASC
      `;
      return res.status(200).json({ engineers: rows });
    }

    if (req.method === "POST") {
      const { iekNumber, name, phone, remarks } = req.body || {};

      if (!iekNumber || !name || !phone) {
        return res.status(400).json({ error: "iekNumber, name and phone are required." });
      }

      const existing = await sql`SELECT id FROM engineers WHERE iek_number = ${iekNumber}`;
      if (existing.length > 0) {
        return res.status(409).json({ error: "An engineer with this IEK number already exists." });
      }

      const [engineer] = await sql`
        INSERT INTO engineers (iek_number, name, phone, remarks)
        VALUES (${iekNumber}, ${name}, ${phone}, ${remarks || null})
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
