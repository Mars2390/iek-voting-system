import { getSql } from "../_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "../_utils.js";

// DELETE /api/candidates/:id -> remove a candidate (admin correction, e.g. wrong entry)
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const candidateId = Number(req.query.id);

  if (!Number.isInteger(candidateId)) {
    return res.status(400).json({ error: "Invalid candidate id." });
  }

  try {
    const [existing] = await sql`SELECT * FROM candidates WHERE id = ${candidateId}`;
    if (!existing) {
      return res.status(404).json({ error: "Candidate not found." });
    }

    if (req.method === "DELETE") {
      await sql`DELETE FROM candidates WHERE id = ${candidateId}`;
      await logAudit(sql, "CANDIDATE_REMOVED", null, getClientIp(req));

      return res.status(200).json({
        success: true,
        deleted: { id: existing.id, name: existing.name, position: existing.position },
      });
    }

    res.setHeader("Allow", "DELETE, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
