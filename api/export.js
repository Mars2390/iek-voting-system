import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

function sendCsv(res, filenameStem, csv) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}_${stamp}.csv"`);
  return res.status(200).send("﻿" + csv);
}

// GET /api/export?type=engineers|stats|candidates|calls|remarks
// Defaults to "engineers" (the full voter register) if type is omitted.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const type = (req.query.type || "engineers").toString();

  try {
    const sql = getSql();

    if (type === "engineers") {
      const rows = await sql`
        SELECT iek_number, name, phone, voted, contact_status, call_count,
               last_contacted_at, confirmed_vote, remarks, created_at
        FROM engineers
        ORDER BY created_at ASC
      `;
      const headers = [
        "IEK Number", "Name", "Phone", "Voted", "Contact Status", "Call Count",
        "Last Contacted", "Confirmed Will Vote", "Legacy Remarks", "Registered At",
      ];
      const csvRows = rows.map((e) => [
        e.iek_number, e.name, e.phone,
        e.voted ? "Voted" : "Not Voted",
        e.contact_status,
        e.call_count,
        e.last_contacted_at ? new Date(e.last_contacted_at).toISOString() : "",
        e.confirmed_vote ? "Yes" : "No",
        e.remarks || "",
        new Date(e.created_at).toISOString(),
      ]);
      return sendCsv(res, "IEK_Voting_Engineers", toCsv(headers, csvRows));
    }

    if (type === "stats") {
      const [row] = await sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE voted)::int AS voted,
          COUNT(*) FILTER (WHERE contact_status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE contact_status = 'confirmed')::int AS confirmed,
          COUNT(*) FILTER (WHERE contact_status = 'no_answer')::int AS no_answer,
          COUNT(*) FILTER (WHERE contact_status = 'busy_declined')::int AS busy_declined,
          COUNT(*) FILTER (WHERE contact_status = 'follow_up')::int AS follow_up,
          COUNT(*) FILTER (WHERE contact_status = 'not_reachable')::int AS not_reachable
        FROM engineers
      `;
      const turnout = row.total > 0 ? Math.round((row.voted / row.total) * 100) : 0;
      const headers = ["Metric", "Value"];
      const csvRows = [
        ["Total Registered", row.total],
        ["Voted", row.voted],
        ["Not Voted", row.total - row.voted],
        ["Turnout %", turnout],
        ["Pending", row.pending],
        ["Confirmed", row.confirmed],
        ["No Answer", row.no_answer],
        ["Busy/Declined", row.busy_declined],
        ["Follow-up Needed", row.follow_up],
        ["Not Reachable", row.not_reachable],
      ];
      return sendCsv(res, "IEK_Voting_Stats", toCsv(headers, csvRows));
    }

    if (type === "candidates") {
      const rows = await sql`
        SELECT name, position, votes, photo_url, created_at
        FROM candidates
        ORDER BY position ASC, votes DESC
      `;
      const headers = ["Name", "Position", "Votes", "Photo URL", "Added At"];
      const csvRows = rows.map((c) => [
        c.name, c.position, c.votes, c.photo_url || "", new Date(c.created_at).toISOString(),
      ]);
      return sendCsv(res, "IEK_Voting_Candidates", toCsv(headers, csvRows));
    }

    if (type === "calls") {
      const rows = await sql`
        SELECT c.called_at, e.name, e.iek_number, c.caller_name, c.call_status, c.notes
        FROM contact_calls c
        LEFT JOIN engineers e ON e.id = c.engineer_id
        ORDER BY c.called_at DESC
      `;
      const headers = ["Date/Time", "Engineer", "IEK Number", "Caller", "Status", "Notes"];
      const csvRows = rows.map((c) => [
        new Date(c.called_at).toISOString(), c.name || "(deleted)", c.iek_number || "",
        c.caller_name, c.call_status, c.notes || "",
      ]);
      return sendCsv(res, "IEK_Voting_Call_History", toCsv(headers, csvRows));
    }

    if (type === "remarks") {
      const rows = await sql`
        SELECT r.created_at, e.name, e.iek_number, r.author, r.remark
        FROM remarks r
        LEFT JOIN engineers e ON e.id = r.engineer_id
        ORDER BY r.created_at DESC
      `;
      const headers = ["Date/Time", "Engineer", "IEK Number", "Author", "Remark"];
      const csvRows = rows.map((r) => [
        new Date(r.created_at).toISOString(), r.name || "(deleted)", r.iek_number || "", r.author, r.remark,
      ]);
      return sendCsv(res, "IEK_Voting_Remarks", toCsv(headers, csvRows));
    }

    return res.status(400).json({ error: "type must be one of: engineers, stats, candidates, calls, remarks" });
  } catch (err) {
    return sendError(res, err);
  }
}
