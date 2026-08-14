import crypto from 'crypto';

/**
 * Generates the public, unguessable token used in customer-facing tracking
 * links (WalkInJob.public_token, HealthSheet.public_token). 24 bytes = 192
 * bits of entropy, base64url so it's short enough for an SMS and URL-safe
 * with no padding to strip.
 *
 * A sequential or predictable id here would let anyone increment their way
 * through other customers' names, cars and bills — this is deliberately
 * expensive to guess.
 */
export function generatePublicToken() {
  return crypto.randomBytes(24).toString('base64url');
}
