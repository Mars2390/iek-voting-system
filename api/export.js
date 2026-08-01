import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/export -> download the full register as CSV
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
      SELECT iek_number, name, phone, voted, remarks, created_at
      FROM engineers
      ORDER BY created_at ASC
    `;

    const headers = ["IEK Number", "Name", "Phone", "Status", "Remarks", "Registered At"];
    const csvRows = rows.map((e) => [
      e.iek_number,
      e.name,
      e.phone,
      e.voted ? "Voted" : "Not Voted",
      e.remarks || "",
      new Date(e.created_at).toISOString(),
    ]);

    const csv = [headers, ...csvRows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="IEK_Voting_Results_${stamp}.csv"`);
    return res.status(200).send("﻿" + csv);
  } catch (err) {
    return sendError(res, err);
  }
}
