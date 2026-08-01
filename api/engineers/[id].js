import { getSql } from "../_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "../_utils.js";

// PUT    /api/engineers/:id -> update name/phone/remarks and/or voted status
// DELETE /api/engineers/:id -> remove an engineer
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const sql = getSql();
  const engineerId = Number(req.query.id);

  if (!Number.isInteger(engineerId)) {
    return res.status(400).json({ error: "Invalid engineer id." });
  }

  try {
    const [existing] = await sql`SELECT * FROM engineers WHERE id = ${engineerId}`;
    if (!existing) {
      return res.status(404).json({ error: "Engineer not found." });
    }

    const ip = getClientIp(req);

    if (req.method === "PUT") {
      const { name, phone, remarks, voted } = req.body || {};

      const nextName = name !== undefined ? name : existing.name;
      const nextPhone = phone !== undefined ? phone : existing.phone;
      const nextRemarks = remarks !== undefined ? remarks : existing.remarks;
      const nextVoted = voted !== undefined ? Boolean(voted) : existing.voted;
      const votedChanged = voted !== undefined && nextVoted !== existing.voted;

      const [updated] = await sql`
        UPDATE engineers
        SET name = ${nextName},
            phone = ${nextPhone},
            remarks = ${nextRemarks},
            voted = ${nextVoted},
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${engineerId}
        RETURNING id, iek_number, name, phone, voted, remarks, created_at, updated_at
      `;

      if (votedChanged && nextVoted) {
        await sql`INSERT INTO votes (engineer_id, voter_ip) VALUES (${engineerId}, ${ip})`;
        await logAudit(sql, "VOTE", engineerId, ip);
      } else if (votedChanged && !nextVoted) {
        await logAudit(sql, "UNDO_VOTE", engineerId, ip);
      } else {
        await logAudit(sql, "UPDATE", engineerId, ip);
      }

      return res.status(200).json({ engineer: updated });
    }

    if (req.method === "DELETE") {
      // Log the audit entry before deleting (while the FK is still valid).
      // ON DELETE SET NULL on audit_log.engineer_id means this row survives
      // the delete below, just with engineer_id nulled out afterward.
      await logAudit(sql, "DELETE", engineerId, ip);
      await sql`DELETE FROM engineers WHERE id = ${engineerId}`;

      return res.status(200).json({
        success: true,
        deleted: { id: existing.id, iek_number: existing.iek_number, name: existing.name },
      });
    }

    res.setHeader("Allow", "PUT, DELETE, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
