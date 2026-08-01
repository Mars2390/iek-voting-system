import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// GET  /api/remarks?engineerId=X -> remark history for one engineer (newest first)
// POST /api/remarks              -> add a remark — body: { engineerId, author, remark }
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();

  try {
    if (req.method === "GET") {
      const id = Number(req.query.engineerId);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "engineerId query parameter is required and must be a number." });
      }
      const rows = await sql`
        SELECT id, engineer_id, author, remark, created_at
        FROM remarks
        WHERE engineer_id = ${id}
        ORDER BY created_at DESC
      `;
      return res.status(200).json({ remarks: rows });
    }

    if (req.method === "POST") {
      const { engineerId, author, remark } = req.body || {};
      const id = Number(engineerId);

      if (!Number.isInteger(id)) {
        return res.status(400).json({ error: "engineerId is required and must be a number." });
      }
      if (!author || !author.trim()) {
        return res.status(400).json({ error: "author is required — identify who is writing this remark." });
      }
      if (!remark || !remark.trim()) {
        return res.status(400).json({ error: "remark text is required." });
      }

      const [engineer] = await sql`SELECT id FROM engineers WHERE id = ${id}`;
      if (!engineer) {
        return res.status(404).json({ error: "Engineer not found." });
      }

      const [row] = await sql`
        INSERT INTO remarks (engineer_id, author, remark)
        VALUES (${id}, ${author.trim()}, ${remark.trim()})
        RETURNING id, engineer_id, author, remark, created_at
      `;

      await logAudit(sql, "REMARK_ADDED", id, getClientIp(req));

      return res.status(201).json({ remark: row });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
