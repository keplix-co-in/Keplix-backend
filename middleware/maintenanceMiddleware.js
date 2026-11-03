/**
 * Maintenance mode for the API.
 *
 * Turned on by setting MAINTENANCE_MODE=true on the Cloud Run service (a new
 * revision, so a restart). While on, every request gets a 503 with
 * code "MAINTENANCE", which both mobile apps catch in services/api.js and turn
 * into their full-screen maintenance page. Background jobs are not started
 * either (see server.js), so nothing writes to the database during a repair.
 *
 * The apps' primary switch is Firebase Remote Config, not this flag: Firebase
 * stays reachable when this server or Supabase is down. This flag is the second
 * layer, for when the server is up but writes must stop (a DB repair or a
 * migration), and it doubles as a safety net if someone flips only this one.
 *
 * Exempt paths:
 *   /health   - Cloud Run must keep seeing the container as alive, or it
 *               restarts it in a loop.
 *   /admin    - the team needs kepix-admin to check the fix before reopening.
 *   /api-docs - development aid only; harmless.
 */
const EXEMPT_PREFIXES = ['/health', '/admin', '/api-docs'];

const DEFAULT_MESSAGE = 'Keplix is down for maintenance. We will be back shortly.';

// Suggested client retry time. Clients do not depend on it; it is the polite
// HTTP signal for a temporary outage.
const RETRY_AFTER_SECONDS = 600;

export const isMaintenanceMode = (env = process.env) => env.MAINTENANCE_MODE === 'true';

const isExempt = (path) =>
  EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

export default function maintenanceMiddleware(req, res, next) {
  if (!isMaintenanceMode() || isExempt(req.path)) return next();

  res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  return res.status(503).json({
    code: 'MAINTENANCE',
    message: process.env.MAINTENANCE_MESSAGE || DEFAULT_MESSAGE,
  });
}
