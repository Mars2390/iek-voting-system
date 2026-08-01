import { getSql } from "./_db.js";
import { applyCors, sendError } from "./_utils.js";

const SAMPLE_ENGINEERS = [
  ["IEK001", "Eng. James Ochieng", "0712345678"],
  ["IEK002", "Eng. Mary Wanjiru", "0723456789"],
  ["IEK003", "Eng. Peter Mwangi", "0734567890"],
  ["IEK004", "Eng. Sarah Akinyi", "0745678901"],
  ["IEK005", "Eng. David Odhiambo", "0756789012"],
  ["IEK006", "Eng. Grace Njeri", "0767890123"],
  ["IEK007", "Eng. Michael Otieno", "0778901234"],
  ["IEK008", "Eng. Faith Wambui", "0789012345"],
];

// POST /api/seed -> insert the 8 sample engineers (idempotent: existing
// IEK numbers are skipped via ON CONFLICT DO NOTHING).
//
// If SEED_SECRET is set as an environment variable, this endpoint requires
// a matching `x-seed-key` header (or `?key=` query param). If SEED_SECRET
// is not set, the endpoint is left open — fine for first-time local setup,
// but you should set SEED_SECRET (or remove this file) before a real
// public election so strangers can't re-seed your production data.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  const requiredKey = process.env.SEED_SECRET;
  const providedKey = req.headers["x-seed-key"] || req.query.key;
  if (requiredKey && providedKey !== requiredKey) {
    return res.status(401).json({ error: "Unauthorized. Provide the correct seed key." });
  }

  try {
    const sql = getSql();
    let inserted = 0;

    for (const [iekNumber, name, phone] of SAMPLE_ENGINEERS) {
      const result = await sql`
        INSERT INTO engineers (iek_number, name, phone)
        VALUES (${iekNumber}, ${name}, ${phone})
        ON CONFLICT (iek_number) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) inserted += 1;
    }

    return res.status(200).json({
      success: true,
      inserted,
      skipped: SAMPLE_ENGINEERS.length - inserted,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
