import crypto from 'crypto';

export const generateOTP = ()=>{
  return crypto.randomInt(100000, 1000000).toString(); // 6-digit OTP
}

// Security O-001: a code is invalidated after this many wrong guesses. Six
// digits is a million combinations; five guesses per issued code makes online
// brute force pointless, however many source IPs the attacker spreads it over.
export const OTP_MAX_ATTEMPTS = 5;

export const OTP_TOO_MANY_ATTEMPTS_MESSAGE =
  'Too many incorrect attempts. Please request a new code.';

// Security O-005: OTPs are stored as HMAC-SHA256(JWT_SECRET, code), never as
// the code itself, so anyone with read access to EmailOTP/PhoneOTP (a backup,
// support tooling, an injection elsewhere) cannot use a pending code.
//
// A keyed HMAC rather than a bare SHA-256: there are only 900,000 six-digit
// codes, so an unkeyed hash is reversed by trying them all. Without the
// server secret that table cannot be built.
//
// Rows written before this change hold the plaintext code. They simply fail to
// verify and the user requests a new code -- acceptable, because every OTP
// expires within minutes anyway. No migration is needed.
const otpKey = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is required to hash OTPs');
    }
    // Matches authController's behaviour of booting without JWT_SECRET
    // outside production. Never reached in a real deploy.
    return 'keplix-dev-otp-key';
  }
  return secret;
};

/**
 * @param {string|number} otp - The plaintext code.
 * @returns {string} 64-char hex HMAC suitable for storing in EmailOTP/PhoneOTP.otp.
 */
export const hashOTP = (otp) =>
  crypto.createHmac('sha256', otpKey()).update(String(otp).trim()).digest('hex');

/**
 * Constant-time check of a submitted code against a stored hash.
 * Security O-001: timingSafeEqual instead of `!==`, which leaks through
 * response timing how much of the value matched.
 *
 * @param {string|number} candidate - Code the user typed.
 * @param {string} storedHash - Value from the OTP row.
 * @returns {boolean}
 */
export const verifyOTP = (candidate, storedHash) => {
  if (candidate === undefined || candidate === null || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashOTP(candidate), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  // Equal length is required by timingSafeEqual; a plaintext legacy row (6
  // chars) is simply a mismatch, never an exception.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/**
 * Spend one guess against an OTP row and check it.
 *
 * Security O-001: the attempt is reserved BEFORE comparing, with a
 * conditional atomic increment (`failedAttempts < MAX`). Comparing first and
 * counting afterwards would let an attacker fire hundreds of guesses in
 * parallel that are all compared before any of them is counted. Reserving
 * first means at most OTP_MAX_ATTEMPTS comparisons can ever happen per code.
 *
 * On the guess that uses up the last attempt without matching, the row is
 * deleted, so the user must request a fresh code.
 *
 * @param {object} delegate - prisma.emailOTP or prisma.phoneOTP (or a tx equivalent).
 * @param {{id:number, otp:string}} record - The row being guessed against.
 * @param {string} candidate - Submitted code.
 * @returns {Promise<{ok: true} | {ok: false, locked: boolean, attemptsLeft: number}>}
 */
export const consumeOtpAttempt = async (delegate, record, candidate) => {
  const reserved = await delegate.updateMany({
    where: { id: record.id, failedAttempts: { lt: OTP_MAX_ATTEMPTS } },
    data: { failedAttempts: { increment: 1 } },
  });

  if (!reserved || reserved.count === 0) {
    // Already exhausted (or deleted by a concurrent final guess).
    await delegate.deleteMany({ where: { id: record.id } }).catch(() => {});
    return { ok: false, locked: true, attemptsLeft: 0 };
  }

  if (verifyOTP(candidate, record.otp)) {
    return { ok: true };
  }

  const used = (record.failedAttempts ?? 0) + 1;
  if (used >= OTP_MAX_ATTEMPTS) {
    await delegate.deleteMany({ where: { id: record.id } }).catch(() => {});
    return { ok: false, locked: true, attemptsLeft: 0 };
  }
  return { ok: false, locked: false, attemptsLeft: OTP_MAX_ATTEMPTS - used };
};

/**
 * Atomically mark an OTP row as used. Call after consumeOtpAttempt() returns ok.
 *
 * Why: findFirst -> compare -> update is a check-then-act race; two concurrent
 * requests carrying the same correct code could both pass the compare and both
 * act on it. The conditional updateMany (verified:false in the where) succeeds
 * for exactly one caller; everyone else gets count 0 and must reject.
 *
 * @param {object} delegate - prisma.emailOTP / prisma.phoneOTP (or tx equivalent).
 * @param {number} id - OTP row id.
 * @returns {Promise<boolean>} true only for the single winning caller.
 */
export const claimOtp = async (delegate, id) => {
  const res = await delegate.updateMany({ where: { id, verified: false }, data: { verified: true } });
  return !!res && res.count === 1;
};
