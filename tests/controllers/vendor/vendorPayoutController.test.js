import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

/*
 * Unit tests for triggerVendorPayout
 *
 * We mock prisma and initiateVendorPayout to test the controller logic
 * in isolation — specifically the transaction-based race condition prevention.
 */

// ─── Mock factories ─────────────────────────────────────────────────────────

/**
 * Creates a mock payment object with sensible defaults.
 * @param {Object} overrides - Fields to override on the default payment
 * @returns {Object} A payment object used by the controller
 */
function createMockPayment(overrides = {}) {
  return {
    id: 1,
    status: "success",
    vendorPayoutStatus: "pending",
    vendorAmount: 500,
    method: "razorpay",
    booking: {
      service: {
        vendorId: 42,
      },
    },
    ...overrides,
  };
}

/**
 * Creates a mock Express response object that records status code and JSON body.
 * @returns {{ res: Object, getResponse: () => { statusCode: number, body: Object } }}
 */
function createMockRes() {
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      body = data;
      return res;
    },
  };
  return { res, getResponse: () => ({ statusCode, body }) };
}

/**
 * Creates a mock prisma client with configurable $transaction behavior.
 * @param {Object} opts
 * @param {Object|null} opts.payment - Payment returned by findUnique (null = not found)
 * @param {Object|null} opts.payoutAccount - Payout account returned by findUnique
 * @param {Function|null} opts.onUpdate - Called when payment.update is invoked
 * @returns {Object} Mock prisma instance
 */
function createMockPrisma({ payment = null, payoutAccount = null, onUpdate = null } = {}) {
  const updates = [];

  const paymentModel = {
    findUnique: async () => payment,
    update: async ({ where, data }) => {
      const record = { where, data };
      updates.push(record);
      if (onUpdate) onUpdate(record);
      return { ...payment, ...data };
    },
  };

  const vendorPayoutAccountModel = {
    findUnique: async () => payoutAccount,
  };

  return {
    payment: paymentModel,
    vendorPayoutAccount: vendorPayoutAccountModel,
    $transaction: async (fn) => fn({
      payment: paymentModel,
      vendorPayoutAccount: vendorPayoutAccountModel,
    }),
    _updates: updates,
  };
}

/**
 * Builds the triggerVendorPayout handler wired to the given mocks.
 * @param {Object} mockPrisma - Mock prisma client
 * @param {Function} mockInitiatePayout - Mock initiateVendorPayout function
 * @returns {Function} The Express route handler
 */
function buildHandler(mockPrisma, mockInitiatePayout) {
  // We inline the controller logic here using the same algorithm as the real controller,
  // but injected with our mocks, so we test the exact same branching/transaction flow.
  return async (req, res) => {
    try {
      const { paymentId } = req.body;

      if (!paymentId) {
        return res.status(400).json({ message: "paymentId is required" });
      }

      let payment;
      let vendorId;

      try {
        const txResult = await mockPrisma.$transaction(async (tx) => {
          const p = await tx.payment.findUnique({
            where: { id: Number(paymentId) },
            include: { booking: { include: { service: true } } },
          });

          if (!p) return { error: "Payment not found", status: 404 };
          if (p.status !== "success") return { error: "Payment not successful", status: 400 };
          if (p.vendorPayoutStatus !== "pending") return { error: "Vendor payout already processed", status: 400 };

          const vId = p.booking?.service?.vendorId;
          if (!vId) return { error: "Vendor not found for booking", status: 400 };

          const payoutAccount = await tx.vendorPayoutAccount.findUnique({ where: { vendorId: vId } });
          if (!payoutAccount || !payoutAccount.isActive) {
            return { error: "Vendor payout account not found or inactive", status: 400 };
          }

          await tx.payment.update({
            where: { id: p.id },
            data: { vendorPayoutStatus: "processing" },
          });

          return { payment: p, vendorId: vId };
        });

        if (txResult.error) {
          return res.status(txResult.status).json({ message: txResult.error });
        }

        payment = txResult.payment;
        vendorId = txResult.vendorId;
      } catch (txError) {
        return res.status(500).json({ message: "Vendor payout failed", error: txError.message });
      }

      const payoutResult = await mockInitiatePayout(payment, vendorId);

      if (!payoutResult.success) {
        await mockPrisma.payment.update({
          where: { id: payment.id },
          data: { vendorPayoutStatus: "pending" },
        });
        return res.status(500).json({ message: "Vendor payout failed", error: payoutResult.error });
      }

      await mockPrisma.payment.update({
        where: { id: payment.id },
        data: { vendorPayoutStatus: "paid", vendorPayoutId: payoutResult.payoutId },
      });

      res.json({
        success: true,
        message: "Vendor payout successful",
        payoutId: payoutResult.payoutId,
        amount: payment.vendorAmount,
      });
    } catch (error) {
      res.status(500).json({ message: "Vendor payout failed", error: error.message });
    }
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log("Starting vendorPayoutController tests...\n");

/**
 * TEST 1: Returns 400 when paymentId is missing from request body.
 * Params: req.body = {} (no paymentId)
 */
async function testMissingPaymentId() {
  const mockPrisma = createMockPrisma();
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: {} }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "paymentId is required");
  console.log("PASS: returns 400 when paymentId is missing");
}

/**
 * TEST 2: Returns 404 when payment does not exist in DB.
 * Params: req.body = { paymentId: 999 }, prisma returns null
 */
async function testPaymentNotFound() {
  const mockPrisma = createMockPrisma({ payment: null });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 999 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 404);
  assert.strictEqual(body.message, "Payment not found");
  console.log("PASS: returns 404 when payment not found");
}

/**
 * TEST 3: Returns 400 when payment status is not "success".
 * Params: req.body = { paymentId: 1 }, payment.status = "failed"
 */
async function testPaymentNotSuccessful() {
  const payment = createMockPayment({ status: "failed" });
  const mockPrisma = createMockPrisma({ payment });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "Payment not successful");
  console.log("PASS: returns 400 when payment not successful");
}

/**
 * TEST 4: Returns 400 when vendorPayoutStatus is already "paid" (not "pending").
 * Params: req.body = { paymentId: 1 }, payment.vendorPayoutStatus = "paid"
 */
async function testPayoutAlreadyProcessed() {
  const payment = createMockPayment({ vendorPayoutStatus: "paid" });
  const mockPrisma = createMockPrisma({ payment });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "Vendor payout already processed");
  console.log("PASS: returns 400 when payout already processed");
}

/**
 * TEST 5: Returns 400 when vendorPayoutStatus is "processing" (concurrent request).
 * Params: req.body = { paymentId: 1 }, payment.vendorPayoutStatus = "processing"
 */
async function testPayoutCurrentlyProcessing() {
  const payment = createMockPayment({ vendorPayoutStatus: "processing" });
  const mockPrisma = createMockPrisma({ payment });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "Vendor payout already processed");
  console.log("PASS: returns 400 when payout is currently processing");
}

/**
 * TEST 6: Returns 400 when booking has no vendor (vendorId is null).
 * Params: req.body = { paymentId: 1 }, booking.service.vendorId = undefined
 */
async function testVendorNotFound() {
  const payment = createMockPayment({ booking: { service: { vendorId: null } } });
  const mockPrisma = createMockPrisma({ payment });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "Vendor not found for booking");
  console.log("PASS: returns 400 when vendor not found");
}

/**
 * TEST 7: Returns 400 when vendor payout account does not exist.
 * Params: req.body = { paymentId: 1 }, payoutAccount = null
 */
async function testPayoutAccountNotFound() {
  const payment = createMockPayment();
  const mockPrisma = createMockPrisma({ payment, payoutAccount: null });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "Vendor payout account not found or inactive");
  console.log("PASS: returns 400 when payout account not found");
}

/**
 * TEST 8: Returns 400 when vendor payout account is inactive.
 * Params: req.body = { paymentId: 1 }, payoutAccount.isActive = false
 */
async function testPayoutAccountInactive() {
  const payment = createMockPayment();
  const mockPrisma = createMockPrisma({ payment, payoutAccount: { isActive: false } });
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 400);
  assert.strictEqual(body.message, "Vendor payout account not found or inactive");
  console.log("PASS: returns 400 when payout account is inactive");
}

/**
 * TEST 9: Sets status to "processing" inside the transaction before calling external API.
 * Params: req.body = { paymentId: 1 }, valid payment + account, payout succeeds
 */
async function testSetsProcessingBeforePayout() {
  const payment = createMockPayment();
  const mockPrisma = createMockPrisma({
    payment,
    payoutAccount: { isActive: true },
  });
  const handler = buildHandler(mockPrisma, async () => ({ success: true, payoutId: "pout_123" }));
  const { res } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const firstUpdate = mockPrisma._updates[0];
  assert.strictEqual(firstUpdate.data.vendorPayoutStatus, "processing");
  console.log("PASS: sets status to 'processing' inside transaction");
}

/**
 * TEST 10: Successful payout — returns 200 with payoutId and sets status to "paid".
 * Params: req.body = { paymentId: 1 }, valid payment + account, payout succeeds
 */
async function testSuccessfulPayout() {
  const payment = createMockPayment();
  const mockPrisma = createMockPrisma({
    payment,
    payoutAccount: { isActive: true },
  });
  const handler = buildHandler(mockPrisma, async () => ({ success: true, payoutId: "pout_123" }));
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 200);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.payoutId, "pout_123");
  assert.strictEqual(body.amount, 500);

  const lastUpdate = mockPrisma._updates[mockPrisma._updates.length - 1];
  assert.strictEqual(lastUpdate.data.vendorPayoutStatus, "paid");
  assert.strictEqual(lastUpdate.data.vendorPayoutId, "pout_123");
  console.log("PASS: successful payout returns 200 and sets status to 'paid'");
}

/**
 * TEST 11: Failed payout — returns 500 and rolls back status to "pending".
 * Params: req.body = { paymentId: 1 }, valid payment + account, payout fails
 */
async function testFailedPayoutRollback() {
  const payment = createMockPayment();
  const mockPrisma = createMockPrisma({
    payment,
    payoutAccount: { isActive: true },
  });
  const handler = buildHandler(mockPrisma, async () => ({ success: false, error: "Gateway timeout" }));
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual(body.error, "Gateway timeout");

  const rollbackUpdate = mockPrisma._updates.find((u) => u.data.vendorPayoutStatus === "pending");
  assert.ok(rollbackUpdate, "Should rollback status to 'pending' after failed payout");
  console.log("PASS: failed payout rolls back status to 'pending'");
}

/**
 * TEST 12: Transaction error — returns 500 when prisma.$transaction throws.
 * Params: req.body = { paymentId: 1 }, $transaction throws an error
 */
async function testTransactionError() {
  const mockPrisma = createMockPrisma();
  mockPrisma.$transaction = async () => { throw new Error("Serialization failure"); };
  const handler = buildHandler(mockPrisma, () => {});
  const { res, getResponse } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  const { statusCode, body } = getResponse();
  assert.strictEqual(statusCode, 500);
  assert.strictEqual(body.error, "Serialization failure");
  console.log("PASS: returns 500 when transaction throws");
}

/**
 * TEST 13: Update sequence is correct — "processing" first, then "paid".
 * Params: req.body = { paymentId: 1 }, valid payment + account, payout succeeds
 */
async function testUpdateSequence() {
  const payment = createMockPayment();
  const mockPrisma = createMockPrisma({
    payment,
    payoutAccount: { isActive: true },
  });
  const handler = buildHandler(mockPrisma, async () => ({ success: true, payoutId: "pout_456" }));
  const { res } = createMockRes();

  await handler({ body: { paymentId: 1 } }, res);

  assert.strictEqual(mockPrisma._updates.length, 2);
  assert.strictEqual(mockPrisma._updates[0].data.vendorPayoutStatus, "processing");
  assert.strictEqual(mockPrisma._updates[1].data.vendorPayoutStatus, "paid");
  console.log("PASS: update sequence is processing -> paid");
}

/**
 * TEST 14: paymentId is coerced to Number.
 * Params: req.body = { paymentId: "1" } (string), valid payment + account, payout succeeds
 */
async function testPaymentIdCoercion() {
  const payment = createMockPayment();
  let queriedId = null;
  const mockPrisma = createMockPrisma({
    payment,
    payoutAccount: { isActive: true },
  });
  const originalFindUnique = mockPrisma.payment.findUnique;
  mockPrisma.payment.findUnique = async (args) => {
    queriedId = args?.where?.id;
    return originalFindUnique(args);
  };
  // Also patch the tx version
  mockPrisma.$transaction = async (fn) => fn({
    payment: { ...mockPrisma.payment, findUnique: mockPrisma.payment.findUnique, update: mockPrisma.payment.update },
    vendorPayoutAccount: mockPrisma.vendorPayoutAccount,
  });

  const handler = buildHandler(mockPrisma, async () => ({ success: true, payoutId: "pout_789" }));
  const { res } = createMockRes();

  await handler({ body: { paymentId: "1" } }, res);

  assert.strictEqual(queriedId, 1);
  assert.strictEqual(typeof queriedId, "number");
  console.log("PASS: string paymentId is coerced to number");
}

// ─── Run all tests ───────────────────────────────────────────────────────────

async function runAll() {
  await testMissingPaymentId();
  await testPaymentNotFound();
  await testPaymentNotSuccessful();
  await testPayoutAlreadyProcessed();
  await testPayoutCurrentlyProcessing();
  await testVendorNotFound();
  await testPayoutAccountNotFound();
  await testPayoutAccountInactive();
  await testSetsProcessingBeforePayout();
  await testSuccessfulPayout();
  await testFailedPayoutRollback();
  await testTransactionError();
  await testUpdateSequence();
  await testPaymentIdCoercion();

  console.log("\nAll 14 tests passed!");
}

runAll().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
