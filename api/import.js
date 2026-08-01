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

const FIELD_SYNONYMS = {
  iek_number: ["iek_number", "iek number", "iekno", "iek no", "iek", "membership no", "membership no.", "membership number"],
  name: ["name", "full name", "fullname"],
  phone: ["phone", "phone number", "phone_number", "mobile", "contact", "telephone"],
  remarks: ["remarks", "notes", "comment", "comments"],
};

// Try to read the first row as a header naming our fields (in any order,
// with any of the synonyms above). Returns a { iek_number, name, phone,
// remarks } -> column index map, or null if it doesn't look like a header
// for our fields at all.
function detectHeaderMap(firstRow) {
  const map = {};
  firstRow.forEach((rawCell, index) => {
    const cell = (rawCell || "").trim().toLowerCase();
    for (const [field, synonyms] of Object.entries(FIELD_SYNONYMS)) {
      if (synonyms.includes(cell) && !(field in map)) {
        map[field] = index;
      }
    }
  });
  return "iek_number" in map && "name" in map ? map : null;
}

// POST /api/import -> bulk-add engineers from CSV text
// body: { csv: "..." }
//
// Two accepted shapes:
//  1. A header row naming the columns (any order, synonyms allowed —
//     "IEK Number", "Membership No.", "Phone Number", etc. all work),
//     followed by data rows with that many columns.
//  2. No recognizable header, in which case the file MUST have exactly
//     4 columns in the fixed order: iek_number, name, phone, remarks.
//
// A file that matches neither shape is REJECTED outright rather than
// guessed at positionally — silently mapping the wrong column into
// "phone" once already corrupted real production data, so this endpoint
// no longer takes that risk.
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

  const allRows = lines.map(parseCsvLine);
  const headerMap = detectHeaderMap(allRows[0]);
  let dataRows = allRows;
  let getField;

  if (headerMap) {
    dataRows = allRows.slice(1);
    getField = (row, field) => (headerMap[field] !== undefined ? (row[headerMap[field]] || "").trim() : "");
  } else {
    const columnCount = allRows[0].length;
    if (columnCount !== 4) {
      return res.status(400).json({
        error: `Couldn't recognize this file's columns. It has ${columnCount} column(s) and no header row ` +
          `naming iek_number/name/phone/remarks. Either add a header row with those column names (in any order), ` +
          `or format the file as exactly 4 columns: iek_number,name,phone,remarks.`,
      });
    }
    getField = (row, field) => {
      const index = { iek_number: 0, name: 1, phone: 2, remarks: 3 }[field];
      return (row[index] || "").trim();
    };
  }

  try {
    const sql = getSql();
    let inserted = 0;
    let skipped = 0;
    const errors = [];

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const iekNumber = getField(row, "iek_number");
      const name = getField(row, "name");
      const phone = getField(row, "phone");
      const remarks = getField(row, "remarks");

      if (!iekNumber || !name) {
        errors.push(`Row ${i + 1}: missing IEK number or name — skipped.`);
        continue;
      }

      const result = await sql`
        INSERT INTO engineers (iek_number, name, phone, remarks)
        VALUES (${iekNumber}, ${name}, ${phone || null}, ${remarks || null})
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
