/**
 * Normalises an Indian mobile number to E.164 (+91XXXXXXXXXX).
 *
 * Every write of a customer/owner phone (WalkInJob.customer_phone,
 * Vehicle.owner_phone, PhoneIdentity.phone_e164) must go through this, and so
 * must the existing PhoneOTP flow — PhoneOTP.phone_number is stored raw
 * today, so "9876543210" and "+919876543210" are already two different OTP
 * records. If the new claim flow normalises and OTP-send doesn't, every
 * verification attempt fails.
 *
 * Returns null (never throws) so callers can turn it into a normal
 * validation error rather than a 500.
 */
export function normalizeIndianPhone(input) {
  if (typeof input !== 'string') return null;

  // Strip everything except digits and a single leading '+'.
  let digits = input.trim().replace(/[^\d+]/g, '');
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\+/g, '');

  // "00" international prefix.
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // 91XXXXXXXXXX (12 digits, with or without an original '+').
  if (digits.length === 12 && digits.startsWith('91')) {
    const local = digits.slice(2);
    return isValidLocal(local) ? `+91${local}` : null;
  }

  // 0XXXXXXXXXX (11 digits, domestic leading zero).
  if (digits.length === 11 && digits.startsWith('0')) {
    const local = digits.slice(1);
    return isValidLocal(local) ? `+91${local}` : null;
  }

  // Bare 10-digit mobile number.
  if (digits.length === 10) {
    return isValidLocal(digits) ? `+91${digits}` : null;
  }

  // A '+' with anything else (non-Indian country code, wrong length) is out
  // of scope for this normaliser — reject rather than guess.
  if (hadPlus) return null;

  return null;
}

/** Indian mobile numbers are 10 digits starting 6-9 (landlines excluded). */
function isValidLocal(local) {
  return /^[6-9]\d{9}$/.test(local);
}
