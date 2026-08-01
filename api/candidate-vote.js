import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// POST /api/candidates/:id/vote -> record one counted ballot for this candidate
//
// This file is deployed at /api/candidate-vote (no brackets). vercel.json
// rewrites /api/candidates/:id/vote -> /api/candidate-vote?id=:id. See
// vercel.json for why this replaced a bracket-folder dynamic route.
//
// Not tied to a specific engineer/voter record — it represents an election
// official recording a tallied ballot for a position, separate from the
// engineers table's turnout tracking (did someone show up and vote). Not
// time-gated by the voting window on purpose: tallying/correction may
// reasonably happen slightly before or after the window while ballots are
// being counted.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const candidateId = Number(req.query.id);
  if (!Number.isInteger(candidateId)) {
    return res.status(400).json({ error: "Invalid candidate id." });
  }

  try {
    const sql = getSql();
    const [updated] = await sql`
      UPDATE candidates
      SET votes = votes + 1
      WHERE id = ${candidateId}
      RETURNING id, name, position, votes, created_at
    `;

    if (!updated) {
      return res.status(404).json({ error: "Candidate not found." });
    }

    await logAudit(sql, "CANDIDATE_VOTE", null, getClientIp(req));

    return res.status(200).json({ candidate: updated });
  } catch (err) {
    return sendError(res, err);
  }
}
