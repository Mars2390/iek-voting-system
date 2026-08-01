import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// GET  /api/candidates -> list all candidates (grouped by position, client-side)
// POST /api/candidates -> add a candidate — body: { name, position, photoUrl? }
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();

  try {
    if (req.method === "GET") {
      const rows = await sql`
        SELECT id, name, position, votes, photo_url, created_at
        FROM candidates
        ORDER BY position ASC, votes DESC, name ASC
      `;
      return res.status(200).json({ candidates: rows });
    }

    if (req.method === "POST") {
      const { name, position, photoUrl } = req.body || {};
      if (!name || !position) {
        return res.status(400).json({ error: "name and position are required." });
      }

      const [candidate] = await sql`
        INSERT INTO candidates (name, position, photo_url)
        VALUES (${name}, ${position}, ${photoUrl || null})
        RETURNING id, name, position, votes, photo_url, created_at
      `;

      await logAudit(sql, "CANDIDATE_ADDED", null, getClientIp(req));

      return res.status(201).json({ candidate });
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
