import { getSql } from "./_db.js";
import { applyCors, logAudit, sendError } from "./_utils.js";

// =========================================================
// ⚠️ INBOUND WEBHOOK — PAYLOAD SHAPE IS UNVERIFIED
//
// Point Sozuri's inbound-SMS / delivery-callback webhook at:
//   https://<your-domain>/api/sms-reply
// (check the Sozuri dashboard for where to configure this — the exact
// setting name/location isn't something I have confirmed docs for).
//
// I don't have a confirmed payload shape for what Sozuri POSTs on an
// inbound reply, so extractPhoneAndMessage() below reads every field
// name it plausibly could be. If replies aren't showing up after you
// wire the webhook, log req.body (temporarily) and adjust the field
// list — everything else in this file (matching, auto-confirm, logging)
// is provider-independent.
// =========================================================

const CONFIRM_KEYWORDS = ["YES", "VOTE"];

function extractPhoneAndMessage(body) {
  const b = body || {};
  const phone = b.from || b.sender || b.msisdn || b.phone || b.source || b.recipient || null;
  const message = b.message || b.text || b.content || b.body || "";
  return { phone: phone ? String(phone) : null, message: String(message || "") };
}

// Same normalization as api/sms.js toSozuriMsisdn — kept in sync manually
// since this file has no other reason to import from sms.js.
function normalizePhone(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  if (digits.length === 10 && digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return `254${digits}`;
  return digits || null;
}

// POST /api/sms-reply — inbound SMS webhook (Sozuri calls this, not the browser)
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  try {
    const sql = getSql();
    const { phone: rawPhone, message } = extractPhoneAndMessage(req.body);
    const normalizedPhone = normalizePhone(rawPhone);

    if (!normalizedPhone) {
      // Still return 200 — the provider shouldn't retry-storm us over a
      // reply we simply couldn't parse.
      return res.status(200).json({ matched: false, error: "Could not parse sender phone from payload." });
    }

    // Match against the last 9 digits so it's tolerant of whichever
    // format is stored on the engineer row (0712..., 254712..., etc).
    const last9 = normalizedPhone.slice(-9);
    const [engineer] = await sql`
      SELECT id, name, phone, contact_status, call_count
      FROM engineers
      WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 9) = ${last9}
      LIMIT 1
    `;

    const upperMessage = message.trim().toUpperCase();
    const matchedKeyword = CONFIRM_KEYWORDS.find((k) => upperMessage === k || upperMessage.startsWith(k + " ") || upperMessage.includes(k));

    await sql`
      INSERT INTO sms_replies (engineer_id, phone, message, matched_keyword)
      VALUES (${engineer?.id || null}, ${normalizedPhone}, ${message}, ${matchedKeyword || null})
    `;

    if (!engineer) {
      return res.status(200).json({ matched: false, phone: normalizedPhone });
    }

    if (matchedKeyword && engineer.contact_status !== "confirmed") {
      await sql`
        INSERT INTO contact_calls (engineer_id, caller_name, call_status, notes)
        VALUES (${engineer.id}, 'SMS Reply (Auto)', 'confirmed', ${`Auto-confirmed from SMS reply: "${message.trim().slice(0, 200)}"`})
      `;
      await sql`
        UPDATE engineers
        SET contact_status = 'confirmed',
            last_contacted_at = CURRENT_TIMESTAMP,
            call_count = call_count + 1,
            confirmed_vote = TRUE,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${engineer.id}
      `;
      await sql`
        UPDATE engineers e SET needs_followup = (
          NOT e.voted AND e.contact_status <> 'confirmed' AND (
            e.call_count >= 3
            OR e.contact_status IN ('follow_up', 'no_answer', 'not_reachable')
            OR NOT EXISTS (SELECT 1 FROM remarks r WHERE r.engineer_id = e.id AND r.created_at > NOW() - INTERVAL '2 days')
          )
        )
        WHERE e.id = ${engineer.id}
      `;
      await logAudit(sql, "SMS_REPLY_AUTO_CONFIRMED", engineer.id, "sozuri-webhook");
    }

    return res.status(200).json({
      matched: true,
      engineerId: engineer.id,
      engineerName: engineer.name,
      autoConfirmed: Boolean(matchedKeyword),
    });
  } catch (err) {
    return sendError(res, err);
  }
}
