// Shared helpers for API route handlers.
// Filename is prefixed with "_" so Vercel excludes it from routing.

export function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Seed-Key");
}

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

export async function logAudit(sql, action, engineerId, ip) {
  await sql`
    INSERT INTO audit_log (action, engineer_id, user_ip)
    VALUES (${action}, ${engineerId}, ${ip})
  `;
}

export function sendError(res, err) {
  console.error(err);
  const message = err && err.message ? err.message : "Unexpected server error.";
  const isConnError = /DATABASE_URL|connect|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(message);

  return res.status(500).json({
    error: isConnError
      ? "Could not connect to the database. Check that DATABASE_URL is configured correctly."
      : "An unexpected error occurred. Please try again.",
    detail: process.env.NODE_ENV === "production" ? undefined : message,
  });
}
