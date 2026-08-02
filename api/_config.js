// Shared election-window configuration.
// Filename is prefixed with "_" so Vercel excludes it from routing.

// Official IEK election start time, confirmed 2026-08-02 against the
// real IEK notice ("voting starts in 14h49m" at 12:12 UTC == 6:00 AM EAT
// Monday, checked to the minute). Earlier values (midnight, then 8 AM)
// were both wrong — this is the one that matches the official notice.
export const VOTING_START = new Date("2026-08-03T06:00:00+03:00"); // Mon Aug 3 2026, 6:00 AM EAT
export const VOTING_END = new Date("2026-08-03T17:00:00+03:00");   // Mon Aug 3 2026, 5:00 PM EAT

// Temporary escape hatch so the voting flow can be tested end-to-end
// BEFORE election day, without the real time-lock getting in the way.
// Set ALLOW_TEST_VOTES=true in Vercel/local env vars to force "live" phase
// regardless of the clock. Remove it (or set to "false") before Monday so
// the real window takes over.
function testModeEnabled() {
  return process.env.ALLOW_TEST_VOTES === "true";
}

export function getElectionPhase(now = new Date()) {
  if (testModeEnabled()) return "live";
  if (now < VOTING_START) return "before";
  if (now <= VOTING_END) return "live";
  return "closed";
}

export function getElectionStatusPayload(now = new Date()) {
  return {
    phase: getElectionPhase(now),
    startsAt: VOTING_START.toISOString(),
    endsAt: VOTING_END.toISOString(),
    serverTime: now.toISOString(),
    testMode: testModeEnabled(),
  };
}
