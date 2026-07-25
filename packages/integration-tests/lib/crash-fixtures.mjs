// Shared fixture text for T5.1 test 4 (crash recovery) — imported by both
// the parent test and the spawned child so wording only lives in one place.
export const TURN1 = 'User: what auth middleware do we use?\n\nAssistant: middleware/verifyJwt.ts, runs before every /api route (crash-test turn 1, FLUSHED).';
export const TURN2 = 'User: what is the postgres pool size?\n\nAssistant: pool max is 20, idleTimeoutMillis 30000 (crash-test turn 2, FLUSHED).';
export const TURN3 = 'User: what does the rate limiter use?\n\nAssistant: express-rate-limit, 100 req/15min per IP via Redis (crash-test turn 3, NEVER FLUSHED — must be lost on crash).';
