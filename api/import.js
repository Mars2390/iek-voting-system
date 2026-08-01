import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const KNOWN_HEADER_FIRST_CELLS = ["iek_number", "iek number", "iekno", "iek no", "iek"];

// POST /api/import -> bulk-add engineers from CSV text
// body: { csv: "IEK009,Eng. Jane Doe,0700000000,optional remarks\n..." }
// Columns (in order): iek_number, name, phone, remarks (remarks optional).
// A header row is auto-detected and skipped if its first cell looks like one.
// Existing IEK numbers are skipped (ON CONFLICT DO NOTHING), never overwritten —
// use PUT /api/engineers/:id to edit an existing record.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const { csv } = req.body || {};
  if (!csv || typeof csv !== "string") {
    return res.status(400).json({ error: "Request body must include a `csv` string." });
  }

  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return res.status(400).json({ error: "CSV is empty." });
  }
  if (lines.length > 2000) {
    return res.status(400).json({ error: "Too many rows in one import (limit: 2000). Split the file." });
  }

  let rows = lines.map(parseCsvLine);
  const firstCell = (rows[0][0] || "").toLowerCase();
  if (KNOWN_HEADER_FIRST_CELLS.includes(firstCell)) {
    rows = rows.slice(1);
  }

  try {
    const sql = getSql();
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const [iekNumber, name, phone, remarks] = rows[i];
      if (!iekNumber || !name || !phone) {
        errors.push(`Row ${i + 1}: missing IEK number, name, or phone — skipped.`);
        continue;
      }

      const result = await sql`
        INSERT INTO engineers (iek_number, name, phone, remarks)
        VALUES (${iekNumber}, ${name}, ${phone}, ${remarks || null})
        ON CONFLICT (iek_number) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) inserted += 1;
      else skipped += 1;
    }

    if (inserted > 0) {
      await logAudit(sql, "BULK_IMPORT", null, getClientIp(req));
    }

    return res.status(200).json({ success: true, inserted, skipped, errors });
  } catch (err) {
    return sendError(res, err);
  }
}
