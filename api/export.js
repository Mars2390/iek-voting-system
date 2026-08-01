import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

function csvEscape(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

function xmlEscape(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Hand-rolled "Excel 2003 XML Spreadsheet" (SpreadsheetML) — not a real
// .xlsx (that's a zip container and needs a library to build correctly),
// but a plain XML file Excel/LibreOffice/Google Sheets have all opened
// natively for 20+ years. Deliberately not adding a dependency (xlsx/
// exceljs) two days before a real election for one export button.
function toExcelXml(sheetName, headers, rows) {
  const headerCells = headers.map((h) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlEscape(h)}</Data></Cell>`).join("");
  const bodyRows = rows.map((r) => {
    const cells = r.map((v) => {
      const isNumber = typeof v === "number" && Number.isFinite(v);
      return `<Cell><Data ss:Type="${isNumber ? "Number" : "String"}">${xmlEscape(v)}</Data></Cell>`;
    }).join("");
    return `<Row>${cells}</Row>`;
  }).join("");

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#0A0A0A" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${xmlEscape(sheetName).slice(0, 31)}">
  <Table>
   <Row>${headerCells}</Row>
   ${bodyRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

function sendReport(res, filenameStem, sheetName, headers, rows, format) {
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "excel") {
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}_${stamp}.xls"`);
    return res.status(200).send(toExcelXml(sheetName, headers, rows));
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameStem}_${stamp}.csv"`);
  return res.status(200).send("﻿" + toCsv(headers, rows));
}

// GET /api/export?type=engineers|stats|candidates|calls|remarks&format=csv|excel
// Defaults to type=engineers, format=csv.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const type = (req.query.type || "engineers").toString();
  const format = (req.query.format || "csv").toString() === "excel" ? "excel" : "csv";

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
      const dataRows = rows.map((e) => [
        e.iek_number, e.name, e.phone,
        e.voted ? "Voted" : "Not Voted",
        e.contact_status,
        e.call_count,
        e.last_contacted_at ? new Date(e.last_contacted_at).toISOString() : "",
        e.confirmed_vote ? "Yes" : "No",
        e.remarks || "",
        new Date(e.created_at).toISOString(),
      ]);
      return sendReport(res, "IEK_Voting_Engineers", "Engineers", headers, dataRows, format);
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
      const dataRows = [
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
      return sendReport(res, "IEK_Voting_Stats", "Stats", headers, dataRows, format);
    }

    if (type === "candidates") {
      const rows = await sql`
        SELECT name, position, votes, photo_url, created_at
        FROM candidates
        ORDER BY position ASC, votes DESC
      `;
      const headers = ["Name", "Position", "Votes", "Photo URL", "Added At"];
      const dataRows = rows.map((c) => [
        c.name, c.position, c.votes, c.photo_url || "", new Date(c.created_at).toISOString(),
      ]);
      return sendReport(res, "IEK_Voting_Candidates", "Candidates", headers, dataRows, format);
    }

    if (type === "calls") {
      const rows = await sql`
        SELECT c.called_at, e.name, e.iek_number, c.caller_name, c.call_status, c.notes
        FROM contact_calls c
        LEFT JOIN engineers e ON e.id = c.engineer_id
        ORDER BY c.called_at DESC
      `;
      const headers = ["Date/Time", "Engineer", "IEK Number", "Caller", "Status", "Notes"];
      const dataRows = rows.map((c) => [
        new Date(c.called_at).toISOString(), c.name || "(deleted)", c.iek_number || "",
        c.caller_name, c.call_status, c.notes || "",
      ]);
      return sendReport(res, "IEK_Voting_Call_History", "Call History", headers, dataRows, format);
    }

    if (type === "remarks") {
      const rows = await sql`
        SELECT r.created_at, e.name, e.iek_number, r.author, r.remark
        FROM remarks r
        LEFT JOIN engineers e ON e.id = r.engineer_id
        ORDER BY r.created_at DESC
      `;
      const headers = ["Date/Time", "Engineer", "IEK Number", "Author", "Remark"];
      const dataRows = rows.map((r) => [
        new Date(r.created_at).toISOString(), r.name || "(deleted)", r.iek_number || "", r.author, r.remark,
      ]);
      return sendReport(res, "IEK_Voting_Remarks", "Remarks", headers, dataRows, format);
    }

    return res.status(400).json({ error: "type must be one of: engineers, stats, candidates, calls, remarks" });
  } catch (err) {
    return sendError(res, err);
  }
}
