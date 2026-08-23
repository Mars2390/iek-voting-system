// Shared Resend email sending.
// Filename is prefixed with "_" so Vercel excludes it from routing —
// it's a helper module, not an API endpoint (same convention as _db.js).

import { Resend } from "resend";

let _resend = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error(
        "RESEND_API_KEY environment variable is not set. Configure it in " +
        ".env.local (development) or Vercel Project Settings -> Environment Variables (production)."
      );
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// {{name}}, {{event_title}}, etc. — a template body/subject with no
// matching var for a given key is left as literal text (never silently
// dropped), so a typo in a template shows up as visibly wrong instead
// of invisibly wrong.
function fillTemplate(str, vars) {
  return String(str || "").replace(/\{\{(\w+)\}\}/g, function (m, key) {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? "") : m;
  });
}

function textToHtml(text) {
  const esc = String(text || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1b1d22;white-space:pre-line;">' +
    esc +
    '</div>'
  );
}

// Sends one email per recipient (not Resend's batch endpoint) so each
// recipient's outcome is known individually — batch send's per-item
// result shape isn't something we could verify without a live account
// to test against, and email_logs needs a trustworthy per-recipient
// count. Runs with bounded concurrency so a large "all engineers" send
// doesn't fire 300+ requests at once.
const CONCURRENCY = 10;

export async function sendBulkEmail({ recipients, subject, body, extraVars }) {
  const resend = getResend();
  const from = process.env.EMAIL_FROM || "National Engineering Strategy Secretariat <NES@engineerhuub.com>";
  const results = [];
  let i = 0;
  async function worker() {
    while (i < recipients.length) {
      const idx = i++;
      const r = recipients[idx];
      const vars = Object.assign({ name: r.name || "there" }, extraVars || {});
      const filledSubject = fillTemplate(subject, vars);
      const filledBody = fillTemplate(body, vars);
      try {
        const { error } = await resend.emails.send({
          from,
          to: r.email,
          subject: filledSubject,
          html: textToHtml(filledBody),
          text: filledBody,
        });
        if (error) throw new Error(error.message || "Resend rejected the message.");
        results.push({ engineerId: r.id, email: r.email, ok: true });
      } catch (err) {
        results.push({ engineerId: r.id, email: r.email, ok: false, error: err.message || String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, recipients.length) }, worker));
  return results;
}

export async function sendSingleEmail({ to, subject, body }) {
  const resend = getResend();
  const from = process.env.EMAIL_FROM || "National Engineering Strategy Secretariat <NES@engineerhuub.com>";
  const { error } = await resend.emails.send({ from, to, subject, html: textToHtml(body), text: body });
  if (error) throw new Error(error.message || "Resend rejected the message.");
}
