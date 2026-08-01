import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// GET    /api/candidates             -> list all candidates
// POST   /api/candidates             -> add a candidate — body: { name, position, photoUrl? }
// DELETE /api/candidates/:id         -> remove a candidate (rewritten to ?id=)
// POST   /api/candidates/:id/vote    -> +1 tallied vote (rewritten to ?id=&vote=1)
//
// Combined into one file (was candidates.js + candidate.js + candidate-vote.js)
// to stay under Vercel's serverless function count limit on the Hobby plan —
// see README "Serverless function count". Browser-facing URLs are unchanged.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const { id, vote } = req.query;

  try {
    // ---------------------------------------------------------
    // Collection endpoints: /api/candidates (no id)
    // ---------------------------------------------------------
    if (id === undefined) {
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
    }

    // ---------------------------------------------------------
    // Single-item endpoints: /api/candidates/:id[/vote]
    // ---------------------------------------------------------
    const candidateId = Number(id);
    if (!Number.isInteger(candidateId)) {
      return res.status(400).json({ error: "Invalid candidate id." });
    }

    if (vote !== undefined) {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return res.status(405).json({ error: `Method ${req.method} not allowed.` });
      }

      const [updated] = await sql`
        UPDATE candidates
        SET votes = votes + 1
        WHERE id = ${candidateId}
        RETURNING id, name, position, votes, photo_url, created_at
      `;
      if (!updated) {
        return res.status(404).json({ error: "Candidate not found." });
      }

      await logAudit(sql, "CANDIDATE_VOTE", null, getClientIp(req));
      return res.status(200).json({ candidate: updated });
    }

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
