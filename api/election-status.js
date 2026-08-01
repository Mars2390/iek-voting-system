import { applyCors, sendError } from "./_utils.js";
import { getElectionStatusPayload } from "./_config.js";

// GET /api/election-status -> { phase, startsAt, endsAt, serverTime, testMode }
// phase is one of: "before" | "live" | "closed"
export default async function handler(req, res) {
  applyCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: `Method ${req.method} not allowed.` });
  }

  try {
    return res.status(200).json(getElectionStatusPayload());
  } catch (err) {
    return sendError(res, err);
  }
}
