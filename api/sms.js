import { getSql } from "./_db.js";
import { applyCors, getClientIp, logAudit, sendError } from "./_utils.js";

// =========================================================
// ⚠️ SOZURI API CONTRACT — UNVERIFIED, READ THIS FIRST
//
// I do not have confirmed, current documentation for Sozuri's exact API
// endpoint/payload shape. Everything below (SOZURI_ENDPOINT, the request
// body shape, and how a successful/failed response is detected) is a
// best-effort implementation, not a verified-against-their-docs one.
//
// Before any bulk send to real voters: send ONE test SMS to your own
// phone first (select just one engineer in the UI). If it fails, the
// error message returned will include Sozuri's raw response — compare
// that against whatever request format you already confirmed works, and
// adjust ONLY the sendViaSozuri() function below. Everything else in this
// file (logging, phone normalization, drafts) is provider-independent.
// =========================================================
const SOZURI_ENDPOINT = "https://msg.sozuri.net/api/v1/messaging";

// Converts Kenyan numbers to the bare-digit format requested (254712345678,
// no "+"). Handles the mixed formats already present in the voter register
// (dashes, leading 0, missing leading 0). Returns null rather than
// guessing when it can't normalize confidently.
function toSozuriMsisdn(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  if (digits.length === 10 && digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return `254${digits}`;
  return null;
}

// Throws only for whole-request transport/config failures — the caller
// logs the specific outcome either way.
async function sendViaSozuri(phone, message) {
  const projectId = process.env.SOZURI_PROJECT_ID;
  const apiKey = process.env.SOZURI_API_KEY;
  const sender = process.env.SOZURI_SENDER;

  if (!projectId || !apiKey) {
    throw new Error("SMS is not configured — set SOZURI_PROJECT_ID and SOZURI_API_KEY in your environment variables.");
  }

  let response;
  try {
    response = await fetch(SOZURI_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project_id: projectId,
        sender_id: sender || undefined,
        recipient: phone,
        message,
      }),
    });
  } catch (networkErr) {
    throw new Error(`Could not reach Sozuri: ${networkErr.message}`);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `Sozuri returned HTTP ${response.status}`);
  }

  return body;
}

// GET  /api/sms                         -> most recent 200 sends, all engineers
// GET  /api/sms?engineerId=X            -> SMS history for one engineer
// GET  /api/sms?kind=drafts             -> list saved drafts
// GET  /api/sms?kind=replies            -> most recent 100 inbound replies
// POST /api/sms                         -> send ONE personalized SMS — body: { engineerId, message, sentBy }
// POST /api/sms?kind=drafts             -> save a draft — body: { title, message, createdBy }
// DELETE /api/sms?kind=drafts&id=X      -> delete a draft
//
// One recipient per POST, not a bulk array — this is deliberate: the
// frontend personalizes [Name] per person and needs a result back after
// each one to drive the "Sent: 10/50" progress bar, so it loops and calls
// this once per recipient (with limited concurrency) rather than sending
// one giant batch request.
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const sql = getSql();
    const { kind, engineerId, id } = req.query;

    if (kind === "drafts") {
      if (req.method === "GET") {
        const rows = await sql`SELECT id, title, message, created_by, created_at, updated_at FROM sms_drafts ORDER BY updated_at DESC`;
        return res.status(200).json({ drafts: rows });
      }
      if (req.method === "POST") {
        const { title, message, createdBy } = req.body || {};
        if (!title || !title.trim()) return res.status(400).json({ error: "title is required." });
        if (!message || !message.trim()) return res.status(400).json({ error: "message is required." });
        const [draft] = await sql`
          INSERT INTO sms_drafts (title, message, created_by)
          VALUES (${title.trim()}, ${message.trim()}, ${createdBy || null})
          RETURNING id, title, message, created_by, created_at, updated_at
        `;
        return res.status(201).json({ draft });
      }
      if (req.method === "DELETE") {
        const draftId = Number(id);
        if (!Number.isInteger(draftId)) return res.status(400).json({ error: "Invalid draft id." });
        await sql`DELETE FROM sms_drafts WHERE id = ${draftId}`;
        return res.status(200).json({ success: true });
      }
      res.setHeader("Allow", "GET, POST, DELETE, OPTIONS");
      return res.status(405).json({ error: `Method ${req.method} not allowed.` });
    }

    if (kind === "replies") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: `Method ${req.method} not allowed.` });
      }
      const rows = await sql`
        SELECT r.id, r.engineer_id, r.phone, r.message, r.matched_keyword, r.created_at,
               e.name AS engineer_name, e.iek_number
        FROM sms_replies r
        LEFT JOIN engineers e ON e.id = r.engineer_id
        ORDER BY r.created_at DESC
        LIMIT 100
      `;
      return res.status(200).json({ replies: rows });
    }

    if (kind === "balance") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET, OPTIONS");
        return res.status(405).json({ error: `Method ${req.method} not allowed.` });
      }
      if (!process.env.SOZURI_PROJECT_ID || !process.env.SOZURI_API_KEY) {
        return res.status(200).json({ balance: null, error: "SMS not configured." });
      }
      // Best-effort — Sozuri's balance/account endpoint path is unverified
      // (same caveat as sendViaSozuri above). Fails gracefully: the UI
      // shows "—" instead of a number rather than breaking anything.
      try {
        const response = await fetch("https://msg.sozuri.net/api/v1/account/balance", {
          headers: { Authorization: `Bearer ${process.env.SOZURI_API_KEY}` },
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.message || `HTTP ${response.status}`);
        return res.status(200).json({ balance: body?.balance ?? body?.credits ?? null, raw: body });
      } catch (err) {
        return res.status(200).json({ balance: null, error: err.message });
      }
    }

    if (req.method === "GET") {
      if (engineerId) {
        const eid = Number(engineerId);
        if (!Number.isInteger(eid)) return res.status(400).json({ error: "Invalid engineerId." });
        const rows = await sql`
          SELECT id, engineer_id, phone, message, status, provider_status, sent_by, created_at
          FROM sms_log WHERE engineer_id = ${eid} ORDER BY created_at DESC
        `;
        return res.status(200).json({ messages: rows });
      }
      const rows = await sql`
        SELECT s.id, s.engineer_id, s.phone, s.message, s.status, s.provider_status, s.sent_by, s.created_at,
               e.name AS engineer_name, e.iek_number
        FROM sms_log s
        LEFT JOIN engineers e ON e.id = s.engineer_id
        ORDER BY s.created_at DESC
        LIMIT 200
      `;
      return res.status(200).json({ messages: rows });
    }

    if (req.method === "POST") {
      if (!process.env.SOZURI_PROJECT_ID || !process.env.SOZURI_API_KEY) {
        return res.status(400).json({
          error: "SMS is not configured yet. Set SOZURI_PROJECT_ID and SOZURI_API_KEY in your environment " +
            "variables (Vercel: Project Settings -> Environment Variables; local: .env.local), then redeploy.",
        });
      }

      const { engineerId: bodyEngineerId, message, sentBy } = req.body || {};
      const eid = Number(bodyEngineerId);

      if (!Number.isInteger(eid)) return res.status(400).json({ error: "engineerId is required and must be a number." });
      if (!message || !message.trim()) return res.status(400).json({ error: "message is required." });
      if (!sentBy || !sentBy.trim()) return res.status(400).json({ error: "sentBy is required — identify who is sending this." });

      const [engineer] = await sql`SELECT id, phone, name FROM engineers WHERE id = ${eid}`;
      if (!engineer) return res.status(404).json({ error: "Engineer not found." });

      const trimmedMessage = message.trim();
      const trimmedSentBy = sentBy.trim();
      const normalizedPhone = toSozuriMsisdn(engineer.phone);

      if (!normalizedPhone) {
        await sql`
          INSERT INTO sms_log (engineer_id, phone, message, status, sent_by)
          VALUES (${eid}, ${engineer.phone || ""}, ${trimmedMessage}, 'invalid_phone', ${trimmedSentBy})
        `;
        return res.status(200).json({ status: "invalid_phone", engineerId: eid, phone: engineer.phone || "" });
      }

      try {
        const result = await sendViaSozuri(normalizedPhone, trimmedMessage);
        const [row] = await sql`
          INSERT INTO sms_log (engineer_id, phone, message, status, provider_status, provider_message_id, sent_by)
          VALUES (${eid}, ${normalizedPhone}, ${trimmedMessage}, 'sent', ${JSON.stringify(result).slice(0, 45)}, ${result?.id || result?.message_id || null}, ${trimmedSentBy})
          RETURNING id
        `;
        await logAudit(sql, "SMS_SENT", eid, getClientIp(req));
        return res.status(200).json({ status: "sent", engineerId: eid, phone: normalizedPhone, logId: row.id });
      } catch (err) {
        await sql`
          INSERT INTO sms_log (engineer_id, phone, message, status, provider_status, sent_by)
          VALUES (${eid}, ${normalizedPhone}, ${trimmedMessage}, 'failed', ${err.message.slice(0, 45)}, ${trimmedSentBy})
        `;
        return res.status(200).json({ status: "failed", engineerId: eid, phone: normalizedPhone, error: err.message });
      }
    }

    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  } catch (err) {
    return sendError(res, err);
  }
}
