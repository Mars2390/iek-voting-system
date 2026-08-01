import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// POST /api/reset-votes -> set every engineer back to "not voted"
//
// This clears the live `voted` flag for a fresh round but does NOT delete
// historical rows from `votes` or `audit_log` — the full audit trail of
// who voted and when is preserved even after a reset.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  try {
    const sql = getSql();
    await sql`UPDATE engineers SET voted = FALSE, updated_at = CURRENT_TIMESTAMP`;
    await logAudit(sql, "RESET_ALL", null, getClientIp(req));

    return res.status(200).json({ success: true });
  } catch (err) {
    return sendError(res, err);
  }
}
