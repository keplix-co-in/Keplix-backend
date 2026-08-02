import assert from 'node:assert';
import crypto from 'node:crypto';

// The logic we implemented in the controller:
function generateIdempotencyKey(bookingId) {
  return crypto.createHash("md5").update(String(bookingId)).digest("hex");
}

console.log("🚀 Starting Idempotency Key Validation Tests...");

// Test 1: Length check (Razorpay limit is 36 characters)
const key1 = generateIdempotencyKey("booking_123");
console.log(`Checking key length for 'booking_123': ${key1} (${key1.length} chars)`);
assert.strictEqual(key1.length, 32, "Key length should be 32 characters (MD5)");
assert.ok(key1.length <= 36, "Key exceeds Razorpay's 36-character limit!");

// Test 2: Determinism (Same bookingId should produce same key)
const key2 = generateIdempotencyKey("booking_123");
assert.strictEqual(key1, key2, "Same bookingId must produce the same idempotency key!");
console.log("✅ Determinism test passed.");

// Test 3: Uniqueness (Different bookingIds should produce different keys)
const key3 = generateIdempotencyKey("booking_456");
assert.notStrictEqual(key1, key3, "Different bookingIds must produce different idempotency keys!");
console.log("✅ Uniqueness test passed.");

// Test 4: Handling non-string inputs
const key4 = generateIdempotencyKey(789);
assert.strictEqual(key4.length, 32, "Key for numeric bookingId should be 32 characters");
console.log("✅ Numeric input test passed.");

console.log("\n🎉 ALL IDEMPOTENCY LOGIC TESTS PASSED!");
console.log("This logic ensures Razorpay will not create duplicate orders if the request is retried.");
