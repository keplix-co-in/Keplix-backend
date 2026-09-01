/**
 * Manual, real-gateway payment test (Razorpay TEST mode).
 *
 * The automated e2e suite (tests/e2e/*) mocks Razorpay, so it proves this
 * codebase's logic is right but not that the Razorpay integration itself
 * works — wrong keys, an SDK version mismatch, a signature format change or a
 * webhook that never arrives would all pass those tests and fail in
 * production. This script closes that gap by driving the REAL endpoints
 * against the REAL Razorpay test API.
 *
 * No real money moves: it refuses to run unless RAZORPAY_KEY_ID is a
 * `rzp_test_` key.
 *
 * Usage:
 *   node scripts/manual_payment_test.mjs           # set up + print checkout link
 *   node scripts/manual_payment_test.mjs --verify  # after paying, check the result
 *   node scripts/manual_payment_test.mjs --cleanup # remove the test rows
 *
 * Test cards (Razorpay test mode): 4111 1111 1111 1111, any future expiry,
 * any CVV, any OTP.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Razorpay from 'razorpay';
import prisma from '../util/prisma.js';
import { resolvePlatformFeeRate } from '../util/platformSettings.js';
import {
  setSuiteTag,
  createCustomer,
  createVendor,
  createService,
  createBooking,
  givePayoutAccount,
  cleanupTestData,
} from '../tests/e2e/helpers/fixtures.js';

const STATE_FILE = path.join(process.cwd(), '.manual-payment-test.json');
const PRICE = 500; // ₹500 test booking

const mode = process.argv.includes('--verify')
  ? 'verify'
  : process.argv.includes('--cleanup')
    ? 'cleanup'
    : 'setup';

// Hard stop: this script creates real orders. In live mode that would be real money.
if (!process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) {
  console.error('REFUSING TO RUN: RAZORPAY_KEY_ID is not a rzp_test_ key.');
  console.error(`Current key: ${process.env.RAZORPAY_KEY_ID}`);
  console.error('This script creates real Razorpay orders — only run it in test mode.');
  process.exit(1);
}

setSuiteTag('manual');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function setup() {
  console.log('Creating test customer, vendor, service and booking...\n');

  const customer = await createCustomer();
  const vendor = await createVendor();
  await givePayoutAccount(vendor.user.id);
  const service = await createService(vendor.user.id, PRICE);
  const booking = await createBooking(customer.user.id, service.id);

  // The real endpoint's own logic: price is resolved server-side, never
  // taken from the client. Mirrored here so the order matches what
  // createPaymentOrder would produce for this booking.
  const order = await razorpay.orders.create({
    amount: Math.round(PRICE * 100),
    currency: 'INR',
    receipt: `rcpt_bk_${booking.id}`,
    notes: { bookingId: String(booking.id) },
  });

  const feeRate = await resolvePlatformFeeRate();
  const expectedFee = PRICE * feeRate;

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ bookingId: booking.id, orderId: order.id, price: PRICE }, null, 2),
  );

  console.log('Set up:');
  console.log(`  booking id : ${booking.id}`);
  console.log(`  order id   : ${order.id}`);
  console.log(`  amount     : ${rupees(PRICE)}`);
  console.log('');
  console.log('Commission settings currently in effect:');
  console.log(`  fee rate       : ${(feeRate * 100).toFixed(2)}%`);
  console.log(`  expected fee   : ${rupees(expectedFee)}`);
  console.log(`  vendor receives: ${rupees(PRICE - expectedFee)}`);
  console.log('');
  console.log('NEXT — pay this order with a Razorpay test card:');
  console.log('');
  console.log('  1. Open the Razorpay dashboard (test mode) -> Orders');
  console.log(`  2. Find order ${order.id} and use its payment link,`);
  console.log('     OR build a checkout page with this key + order id:');
  console.log(`       key_id   = ${process.env.RAZORPAY_KEY_ID}`);
  console.log(`       order_id = ${order.id}`);
  console.log('  3. Card 4111 1111 1111 1111, any future expiry, any CVV/OTP');
  console.log('');
  console.log('Then run:  node scripts/manual_payment_test.mjs --verify');
}

async function verify() {
  if (!fs.existsSync(STATE_FILE)) {
    console.error('No test in progress. Run without --verify first.');
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  console.log(`Checking order ${state.orderId} and booking ${state.bookingId}...\n`);

  // What Razorpay itself says happened.
  const payments = await razorpay.orders.fetchPayments(state.orderId);
  const captured = (payments.items ?? []).filter((p) => p.status === 'captured');

  console.log(`Razorpay reports ${payments.items?.length ?? 0} payment attempt(s), ${captured.length} captured.`);
  for (const p of payments.items ?? []) {
    console.log(`  ${p.id}  ${p.status.padEnd(10)} ${rupees(p.amount / 100)}  ${p.method ?? ''}`);
  }

  if (captured.length === 0) {
    console.log('\nNothing captured yet — pay the order first, then re-run --verify.');
    return;
  }

  // What OUR database recorded. This is the part that proves the integration
  // works end to end rather than just that Razorpay accepted a card.
  const payment = await prisma.payment.findUnique({
    where: { bookingId: state.bookingId },
    include: { booking: true },
  });

  console.log('');
  if (!payment) {
    console.log('❌ Razorpay captured the payment but NO Payment row exists in the database.');
    console.log('   The verify endpoint was never called, or the webhook never arrived.');
    console.log('   This is exactly the class of failure the mocked tests cannot catch.');
    return;
  }

  const feeRate = await resolvePlatformFeeRate();
  const expectedFee = Number(payment.amount) * feeRate;
  const actualFee = Number(payment.platformFee);
  const actualVendor = Number(payment.vendorAmount);
  const feeMatches = Math.abs(actualFee - expectedFee) < 0.01;
  const splitAddsUp = Math.abs(actualFee + actualVendor - Number(payment.amount)) < 0.01;

  console.log('Database recorded:');
  console.log(`  status          : ${payment.status}`);
  console.log(`  amount          : ${rupees(payment.amount)}`);
  console.log(`  platform fee    : ${rupees(actualFee)}  ${feeMatches ? '✅' : `❌ expected ${rupees(expectedFee)}`}`);
  console.log(`  vendor amount   : ${rupees(actualVendor)}`);
  console.log(`  fee + vendor    : ${splitAddsUp ? '✅ adds up to the total' : '❌ DOES NOT add up'}`);
  console.log(`  payout status   : ${payment.vendorPayoutStatus}`);
  console.log(`  booking status  : ${payment.booking.status}`);
  console.log(`  transaction id  : ${payment.transactionId}`);

  console.log('');
  if (payment.status === 'success' && feeMatches && splitAddsUp) {
    console.log('✅ Payment recorded correctly, commission split matches the current settings.');
    console.log('   Tip: flip the commission toggle in kepix-admin and run this again to');
    console.log('   confirm the setting really drives the split.');
  } else {
    console.log('❌ Something is off — see the mismatches above.');
  }
}

async function cleanup() {
  const result = await cleanupTestData();
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  console.log(`Cleaned up test data (${result.users ?? 0} user rows and their bookings/payments).`);
}

try {
  if (mode === 'setup') await setup();
  else if (mode === 'verify') await verify();
  else await cleanup();
} catch (err) {
  console.error(`\nFailed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
