// Shared Sozuri SMS sender. Filename is prefixed with "_" so Vercel
// excludes it from routing — it's a helper module, not an API endpoint
// (same convention as _db.js / _email.js). Extracted from api/sms.js so
// the campaign SMS tool (api/auth.js, `campaign-sms-dispatch`) sends
// through exactly the same verified contract as the SMS Draft Center,
// instead of a second copy that could drift.

// =========================================================
// SOZURI API CONTRACT — this matches the exact cURL example shown on
// this project's own "API Credentials" dashboard page (the authoritative
// source — more specific than the general public docs used earlier).
//
// POST https://sozuri.net/api/v1/messaging
// Headers: Content-Type: application/json, Accept: application/json
//          (NO Authorization header — apiKey travels in the body instead)
// Body:    { project, apiKey, from, to, message, channel: "sms", type }
// Success: { messageData: { messages: N }, recipients: [{ messageId, to, status, statusCode, ... }] }
// Error:   { messageData: { message: "..." } }  -or-  { error_code, message, retryable }
//
// CONFIRMED: SOZURI_PROJECT_ID must be the project's dashboard DISPLAY
// NAME ("IEK ELECTION"), not the opaque project ID string — using the ID
// produced 401 AUTHENTICATION_FAILED; the name authenticates correctly.
// (A Bearer-header variant also authenticated in earlier testing, but the
// dashboard's own example is the one to trust going forward.)
//
// type: "promotional" — the one message that was confirmed "Delivered"
// on the dashboard (not just "Accepted") used this type. It comes with a
// carrier-mandated opt-out suffix appended to the text automatically
// (e.g. "...STOP*456*9*5#") — a Kenyan regulatory requirement for bulk/
// marketing SMS, not a bug. If a "transactional" route gets separately
// approved on the account later, flipping this constant is the only
// change needed.
//
// ⚠️ GOTCHA: Sozuri returns HTTP 200 even for request-level errors (e.g.
// a bad/missing recipient), with the real error in `messageData.message`
// and NO `recipients` array. Checking `response.ok` alone is not enough —
// see the `recipients` presence check below.
// =========================================================
const SOZURI_ENDPOINT = "https://sozuri.net/api/v1/messaging";
const SOZURI_MESSAGE_TYPE = "promotional";

export function smsIsConfigured() {
  return !!(process.env.SOZURI_PROJECT_ID && process.env.SOZURI_API_KEY);
}

// Converts Kenyan numbers to the bare-digit format requested (254712345678,
// no "+"). Handles the mixed formats already present in the voter register
// (dashes, leading 0, missing leading 0). Returns null rather than
// guessing when it can't normalize confidently.
export function toSozuriMsisdn(rawPhone) {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  if (digits.length === 10 && digits.startsWith("0")) return `254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return `254${digits}`;
  return null;
}

// Throws for both transport failures and Sozuri-reported request errors
// (including the HTTP-200-but-actually-an-error case — see file header).
// `err.debugRequest` carries exactly what was sent (API key redacted) so
// the caller can hand it back to the frontend for on-screen debugging.
export async function sendViaSozuri(phone, message) {
  const projectId = process.env.SOZURI_PROJECT_ID;
  const apiKey = process.env.SOZURI_API_KEY;
  const sender = process.env.SOZURI_SENDER;

  if (!projectId || !apiKey) {
    throw new Error("SMS is not configured — set SOZURI_PROJECT_ID and SOZURI_API_KEY in your environment variables.");
  }

  const requestBody = {
    project: projectId,
    apiKey,
    from: sender || undefined,
    to: phone,
    message,
    channel: "sms",
    type: SOZURI_MESSAGE_TYPE,
  };
  // Redacted copy for logs/debug responses — never expose the real key.
  const redactedBody = { ...requestBody, apiKey: "[redacted]" };
  const debugRequest = { url: SOZURI_ENDPOINT, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: redactedBody };

  // Visible in `vercel logs` / the Vercel dashboard function logs — never
  // logs the API key itself.
  console.log("[sozuri] request:", JSON.stringify(redactedBody));

  let response;
  try {
    response = await fetch(SOZURI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });
  } catch (networkErr) {
    const err = new Error(`Could not reach Sozuri: ${networkErr.message}`);
    err.debugRequest = debugRequest;
    throw err;
  }

  const body = await response.json().catch(() => null);
  console.log("[sozuri] response:", response.status, JSON.stringify(body));

  const recipient = body?.recipients?.[0];
  if (!response.ok || !recipient) {
    const err = new Error(body?.messageData?.message || body?.message || `Sozuri returned HTTP ${response.status} with no recipient confirmation.`);
    err.debugRequest = debugRequest;
    err.debugResponse = body;
    throw err;
  }

  return body;
}
