import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';

const mockOrderId = "order_N123456789";
const mockRazorpayKey = "rzp_test_123";

async function simulateCreatePaymentOrder(req, razorpayMock) {
  const { amount, currency = "INR", gateway, bookingId } = req.body;
  if (!amount) return { status: 400, body: { message: "Amount is required" } };
  if (!bookingId) return { status: 400, body: { message: "Booking ID is required" } };

  const idempotencyKey = crypto.createHash("md5").update(String(bookingId)).digest("hex");
  const order = await razorpayMock.orders.create({
    amount: Math.round(amount * 100),
    currency,
    receipt: `rcpt_bk_${bookingId}`,
  }, {
    "X-Razorpay-Idempotency-Key": idempotencyKey
  });

  const finalOrderId = order.id || order.orderId;
  return {
    status: 200,
    body: {
      id: finalOrderId,
      orderId: finalOrderId,
      amount: order.amount,
      currency: order.currency,
      key_id: mockRazorpayKey,
      gateway: 'razorpay'
    }
  };
}

test('Complete Workflow: createPaymentOrder with Idempotency', async (t) => {
  const req = { body: { amount: 500, bookingId: 99, currency: "INR" } };
  const razorpayMock = {
    orders: {
      create: async (params, headers) => {
        assert.strictEqual(params.amount, 50000);
        assert.strictEqual(params.receipt, "rcpt_bk_99");
        const expectedKey = crypto.createHash("md5").update("99").digest("hex");
        assert.strictEqual(headers["X-Razorpay-Idempotency-Key"], expectedKey);
        return { id: mockOrderId, amount: 50000, currency: "INR" };
      }
    }
  };
  const result = await simulateCreatePaymentOrder(req, razorpayMock);
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.body.id, mockOrderId);
});

test('Validation: Missing Amount', async (t) => {
  const req = { body: { bookingId: 99 } };
  const result = await simulateCreatePaymentOrder(req, {});
  assert.strictEqual(result.status, 400);
});

test('Validation: Missing BookingId', async (t) => {
  const req = { body: { amount: 100 } };
  const result = await simulateCreatePaymentOrder(req, {});
  assert.strictEqual(result.status, 400);
});
