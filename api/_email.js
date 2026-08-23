// Shared Resend email sending + inbound-reply handling.
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

function emailFrom() {
  return process.env.EMAIL_FROM || "National Engineering Strategy Secretariat <NES@engineerhuub.com>";
}
// Where a reply actually goes when someone hits "Reply" in their email
// client. Deliberately NOT the same address as emailFrom(): NES@engineerhuub.com
// is a real Google Workspace mailbox (see the domain-setup discussion from
// an earlier session), and a domain's MX records are domain/subdomain-wide
// — they can't be split per-address on the same host. Resend's own inbound
// docs recommend exactly this: point a separate subdomain's MX at Resend
// so it doesn't fight with an existing mail provider on the root domain.
// Falls back to emailFrom() so the app still runs (replies just won't be
// receivable) before that subdomain is set up.
function emailReplyTo() {
  return process.env.EMAIL_REPLY_TO || emailFrom();
}
function replyDomain() {
  const m = /@([^\s>]+)>?\s*$/.exec(emailReplyTo());
  return m ? m[1] : "engineerhuub.com";
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

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// Bare URLs in a plain-text template body become real clickable links in
// the HTML version — templates are authored as plain text (see
// migrations/014_email_system.sql's seeded bodies), so this is the only
// way a link in one actually becomes clickable rather than just sitting
// there as text.
function linkify(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, function (url) {
    return '<a href="' + url + '" style="color:#0d9488;text-decoration:underline;">' + url + "</a>";
  });
}

// Professional branded wrapper — table-based layout (not flexbox/grid)
// because that's what actually renders consistently across real email
// clients (Outlook's rendering engine is Word's HTML engine, not a
// browser one); inline styles because most clients strip <style> blocks
// entirely. Navy/teal per the explicit brief for email specifically —
// the site itself uses IEK's red/green, but a bulk-mail brand color is a
// separate, deliberate choice from the in-app UI palette.
function renderHtmlEmail({ preheader, bodyText, ctaLabel, ctaUrl }) {
  const withLinks = linkify(escapeHtml(bodyText || "")).replace(/\n/g, "<br>");
  return renderHtmlEmailRaw({
    preheader,
    innerHtml: '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#1b2733;">' + withLinks + "</td></tr></table>",
    ctaLabel, ctaUrl,
  });
}

// Structured event-details card (date/time, location) rendered as its
// own bordered block rather than folded into the paragraph text — scannable
// at a glance is the whole point of an event invite, and that's lost if
// the date/location are just more words in a sentence.
function renderEventDetailsCard({ dateStr, location }) {
  const row = (icon, text) =>
    text
      ? '<tr><td style="padding:6px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1b2733;">' +
        '<span style="display:inline-block;width:22px;">' + icon + "</span>" + escapeHtml(text) + "</td></tr>"
      : "";
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fa;border:1px solid #e4e9ef;border-radius:10px;margin:18px 0;">' +
    '<tr><td style="padding:16px 18px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' +
    row("&#128197;", dateStr) +
    row("&#128205;", location) +
    "</table></td></tr></table>"
  );
}

// Dedicated renderer for IEK Calendar event invitations — the generic
// renderHtmlEmail() wrapper is a single paragraph of text, which loses
// exactly the things that make an invite actually useful: a date/time
// and location scannable at a glance, and one unambiguous place to
// register. introText is the (optionally admin-edited) template body,
// kept as the human framing above the structured details.
function renderEventEmailHtml({ introText, eventTitle, dateStr, location, description, registerUrl }) {
  const introHtml = linkify(escapeHtml(introText || "")).replace(/\n/g, "<br>");
  const descriptionHtml = description
    ? '<tr><td style="padding:4px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14.5px;line-height:1.65;color:#1b2733;">' +
      linkify(escapeHtml(description)).replace(/\n/g, "<br>") + "</td></tr>"
    : "";
  const ctaUrl = registerUrl || "https://www.engineerhuub.com/calendar.html";
  const ctaLabel = registerUrl ? "Register Now" : "View on IEK Calendar";
  return renderHtmlEmailRaw({
    preheader: "You're invited: " + eventTitle,
    innerHtml:
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
      '<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#1b2733;">' + introHtml + "</td></tr>" +
      '<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:800;color:#0f2942;padding-top:14px;">' + escapeHtml(eventTitle) + "</td></tr>" +
      '<tr><td>' + renderEventDetailsCard({ dateStr, location }) + "</td></tr>" +
      descriptionHtml +
      "</table>",
    ctaLabel, ctaUrl,
  });
}

// The shared chrome (header/footer/card) factored out of renderHtmlEmail
// so the event-invite renderer can drop in its own structured body
// instead of a single linkified paragraph, without duplicating the
// header/footer markup.
function renderHtmlEmailRaw({ preheader, innerHtml, ctaLabel, ctaUrl }) {
  const cta = ctaUrl
    ? '<tr><td style="padding:16px 0 4px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:8px;background:#0d9488;">' +
      '<a href="' + escapeHtml(ctaUrl) + '" style="display:inline-block;padding:14px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">' +
      escapeHtml(ctaLabel || "Open Engineer Hub") + "</a></td></tr></table></td></tr>"
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(preheader || "Engineer Hub")}</title>
</head>
<body style="margin:0;padding:0;background:#eef2f6;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || "")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,0.06);">
<tr><td style="background:#0f2942;padding:22px 28px;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="font-family:Arial,Helvetica,sans-serif;font-size:19px;font-weight:800;color:#ffffff;">Engineer<span style="color:#2dd4bf;">Hub</span></td>
</tr></table>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9fb3c8;margin-top:2px;">National Engineering Strategy Secretariat</div>
</td></tr>
<tr><td style="padding:32px 28px 8px;">
${innerHtml}
${cta}
</td></tr>
<tr><td style="padding:26px 28px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e4e9ef;padding-top:18px;">
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#8b96a3;">
Engineer Hub — a network for IEK-affiliated engineers.<br>
<a href="https://www.engineerhuub.com/settings.html" style="color:#0d9488;">Manage your email preferences</a>
&nbsp;·&nbsp;
<a href="https://www.engineerhuub.com/privacy.html" style="color:#0d9488;">Privacy Policy</a>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// Sends one email per recipient (not Resend's batch endpoint) so each
// recipient's outcome is known individually — batch send's per-item
// result shape isn't something we could verify without a live account
// to test against, and email_logs needs a trustworthy per-recipient
// count. Runs with bounded concurrency so a large "all engineers" send
// doesn't fire 300+ requests at once.
const CONCURRENCY = 10;

// Shared fan-out: calls buildMessage(recipient) -> {subject, html, text}
// for each recipient and sends it, bounded to CONCURRENCY in flight.
// Both sendBulkEmail and sendEventInviteEmail are just different ways of
// building that per-recipient message.
async function sendPerRecipient(recipients, buildMessage) {
  const resend = getResend();
  const from = emailFrom();
  const replyTo = emailReplyTo();
  const results = [];
  let i = 0;
  async function worker() {
    while (i < recipients.length) {
      const idx = i++;
      const r = recipients[idx];
      try {
        const msg = buildMessage(r);
        const { data, error } = await resend.emails.send({ from, replyTo, to: r.email, ...msg });
        if (error) throw new Error(error.message || "Resend rejected the message.");
        results.push({ engineerId: r.id, email: r.email, ok: true, resendId: data && data.id });
      } catch (err) {
        results.push({ engineerId: r.id, email: r.email, ok: false, error: err.message || String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, recipients.length) }, worker));
  return results;
}

export async function sendBulkEmail({ recipients, subject, body, extraVars, ctaLabel, ctaUrl }) {
  return sendPerRecipient(recipients, (r) => {
    const vars = Object.assign({ name: r.name || "there" }, extraVars || {});
    const filledSubject = fillTemplate(subject, vars);
    const filledBody = fillTemplate(body, vars);
    return {
      subject: filledSubject,
      html: renderHtmlEmail({ preheader: filledSubject, bodyText: filledBody, ctaLabel, ctaUrl }),
      text: filledBody,
    };
  });
}

// Event invitations get their own structured layout (see
// renderEventEmailHtml) instead of the generic single-paragraph one —
// a date/time/location that's scannable at a glance, and one
// unambiguous Register button, is the actual point of an invite.
export async function sendEventInviteEmail({ recipients, subjectTemplate, introTemplate, event }) {
  return sendPerRecipient(recipients, (r) => {
    const vars = { name: r.name || "there", event_title: event.title, event_date: event.dateStr, event_location: event.location ? " at " + event.location : "" };
    const filledSubject = fillTemplate(subjectTemplate, vars);
    const filledIntro = fillTemplate(introTemplate, vars);
    const html = renderEventEmailHtml({
      introText: filledIntro, eventTitle: event.title, dateStr: event.dateStr,
      location: event.location, description: event.description, registerUrl: event.registerUrl,
    });
    const textParts = [filledIntro, "", event.title, event.dateStr, event.location || null, event.description || null, event.registerUrl ? "Register: " + event.registerUrl : null].filter(Boolean);
    return { subject: filledSubject, html, text: textParts.join("\n") };
  });
}

export async function sendSingleEmail({ to, subject, body, ctaLabel, ctaUrl }) {
  const resend = getResend();
  const { error } = await resend.emails.send({
    from: emailFrom(),
    replyTo: emailReplyTo(),
    to,
    subject,
    html: renderHtmlEmail({ preheader: subject, bodyText: body, ctaLabel, ctaUrl }),
    text: body,
  });
  if (error) throw new Error(error.message || "Resend rejected the message.");
}

// Support-thread email: sets a Message-ID we control (embeds the thread
// id directly) so a reply's In-Reply-To/References headers can be
// matched straight back to the thread — no fuzzy "Re: Re:" subject
// parsing needed. inReplyTo, when given, is the inbound message's own
// Message-ID (from the last message we received in this thread), so
// the recipient's client visually groups this reply under it too.
export async function sendThreadEmail({ to, subject, body, threadId, messageRowId, inReplyTo }) {
  const resend = getResend();
  const domain = replyDomain();
  const ourMessageId = `<eh-thread-${threadId}-${messageRowId}@${domain}>`;
  const headers = { "Message-ID": ourMessageId };
  if (inReplyTo) {
    headers["In-Reply-To"] = inReplyTo;
    headers["References"] = inReplyTo;
  }
  const { data, error } = await resend.emails.send({
    from: emailFrom(),
    replyTo: emailReplyTo(),
    to,
    subject,
    headers,
    html: renderHtmlEmail({ preheader: subject, bodyText: body }),
    text: body,
  });
  if (error) throw new Error(error.message || "Resend rejected the message.");
  return { resendEmailId: data && data.id, outboundMessageId: ourMessageId };
}

// ---------- Inbound (replies) ----------

// Throws on a bad/missing signature — callers should respond 401 rather
// than process an unverified payload (anyone who knew the endpoint URL
// could otherwise inject fake "replies").
export function verifyInboundWebhook(rawBody, headers) {
  const resend = getResend();
  if (!process.env.RESEND_WEBHOOK_SECRET) {
    throw new Error("RESEND_WEBHOOK_SECRET environment variable is not set.");
  }
  return resend.webhooks.verify({
    payload: rawBody,
    headers: { id: headers["svix-id"], timestamp: headers["svix-timestamp"], signature: headers["svix-signature"] },
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
  });
}

// The webhook event itself only carries metadata (Resend's own docs:
// "Webhooks do not include the email body, headers, or attachments") —
// this is the follow-up call for the actual text/html/headers.
export async function fetchReceivedEmail(id) {
  const resend = getResend();
  const { data, error } = await resend.emails.receiving.get(id);
  if (error) throw new Error(error.message || "Couldn't fetch the received email from Resend.");
  return data;
}

// Header keys are case-insensitive per RFC 5322, and it isn't documented
// which casing Resend normalizes them to — looked up case-insensitively
// rather than assuming "In-Reply-To"/"References" exactly.
function headerLookup(headers, name) {
  if (!headers) return null;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}
export function extractThreadIdFromHeaders(headers) {
  const haystack = [headerLookup(headers, "In-Reply-To"), headerLookup(headers, "References")].filter(Boolean).join(" ");
  const m = /eh-thread-(\d+)-\d+@/.exec(haystack);
  return m ? Number(m[1]) : null;
}
