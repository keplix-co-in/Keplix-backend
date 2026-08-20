import { jest } from '@jest/globals';

// Mock prisma — no real DB connection
jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    vendorProfile: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 10, userId: 1 }),
    },
    user: {
      update: jest.fn().mockResolvedValue({ id: 1, role: 'vendor' }),
    },
    // updateVendorProfile wraps the profile write and the role promotion in a
    // single transaction; the mock just runs the callback against itself.
    $transaction: jest.fn(),
    booking: {
      count: jest.fn(),
    },
    payment: {
      aggregate: jest.fn(),
    },
    // getVendorProfile now reports payout readiness so the vendor app can
    // prompt for bank details rather than letting a settlement fail silently
    // weeks later.
    vendorPayoutAccount: {
      findUnique: jest.fn().mockResolvedValue({ vendorId: 1, isActive: true }),
    },
  },
}));

// Mock payout helpers so imports don't fail
jest.unstable_mockModule('../../../util/payoutHelper.js', () => ({
  setupVendorPayoutAccount: jest.fn(),
  updateVendorPayoutAccount: jest.fn(),
}));

const { getVendorProfile, updateVendorProfile } = await import('../../../controllers/vendor/profileController.js');
const prisma = (await import('../../../util/prisma.js')).default;

function mockReq(overrides = {}) {
  return {
    user: { id: 1 },
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.vendorProfile.update.mockResolvedValue({ id: 10, userId: 1 });
  prisma.user.update.mockResolvedValue({ id: 1, role: 'vendor' });
  prisma.$transaction.mockImplementation((cb) => cb(prisma));
});

// ─── getVendorProfile ───────────────────────────────────────────────
// Note: rating/numReviews are maintained incrementally on VendorProfile
// (see util/ratingHelper.js) rather than re-aggregated from Review on
// every profile view, so these tests set `rating` directly on the
// vendorProfile.findUnique fixture instead of mocking review.aggregate.

describe('getVendorProfile', () => {

  // --- Happy path: vendor with bookings, payments, and reviews ---
  it('should return profile with correct aggregated stats', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Test Shop',
      rating: 4.3,
      user: { id: 1, name: 'Vendor' },
    });
    prisma.booking.count.mockResolvedValue(25);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: 5000.50, amount: 6000 },
    });

    await getVendorProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        business_name: 'Test Shop',
        rating: '4.3',
        total_orders: 25,
        total_earnings: '5000.50',
      })
    );
  });

  // --- Edge case: vendor profile not found ---
  it('should return 404 when vendor profile does not exist', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue(null);

    await getVendorProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Vendor profile not found' });
    // Aggregate queries should NOT be called when profile doesn't exist
    expect(prisma.booking.count).not.toHaveBeenCalled();
    expect(prisma.payment.aggregate).not.toHaveBeenCalled();
  });

  // --- Edge case: zero bookings (new vendor) ---
  it('should return zero stats for a vendor with no bookings', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'New Shop',
      rating: 0,
      user: { id: 1 },
    });
    prisma.booking.count.mockResolvedValue(0);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: null, amount: null },
    });

    await getVendorProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: '0.0',
        total_orders: 0,
        total_earnings: '0.00',
      })
    );
  });

  // --- Edge case: vendorAmount is null, falls back to amount ---
  it('should fall back to payment.amount when vendorAmount is null', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Shop',
      rating: 5.0,
      user: { id: 1 },
    });
    prisma.booking.count.mockResolvedValue(3);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: null, amount: 1500 },
    });

    await getVendorProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total_earnings: '1500.00',
      })
    );
  });

  // --- Edge case: both vendorAmount and amount are null ---
  it('should return 0.00 earnings when both vendorAmount and amount are null', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Shop',
      rating: 3.5,
      user: { id: 1 },
    });
    prisma.booking.count.mockResolvedValue(2);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: null, amount: null },
    });

    await getVendorProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total_earnings: '0.00',
      })
    );
  });

  // --- Edge case: bookings exist but no reviews yet ---
  it('should return 0.0 rating when there are bookings but no reviews', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Shop',
      rating: 0,
      user: { id: 1 },
    });
    prisma.booking.count.mockResolvedValue(10);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: 2000, amount: 2500 },
    });

    await getVendorProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: '0.0',
        total_orders: 10,
      })
    );
  });

  // --- Edge case: rating rounds correctly ---
  it('should round average rating to 1 decimal place', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Shop',
      rating: 4.6667,
      user: { id: 1 },
    });
    prisma.booking.count.mockResolvedValue(5);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: 100, amount: 100 },
    });

    await getVendorProfile(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        rating: '4.7',
      })
    );
  });

  // --- Edge case: DB error returns 500 ---
  it('should return 500 when a database query fails', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockRejectedValue(new Error('DB connection lost'));

    await getVendorProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Server Error' });
  });

  // --- Edge case: aggregate query fails after profile is found ---
  it('should return 500 when an aggregate query fails', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Shop',
      rating: 0,
      user: { id: 1 },
    });
    prisma.booking.count.mockRejectedValue(new Error('timeout'));

    await getVendorProfile(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Server Error' });
  });

  // --- Verify both aggregate queries run in parallel, with correct filters ---
  it('should call the orders and earnings aggregate queries', async () => {
    const req = mockReq();
    const res = mockRes();

    prisma.vendorProfile.findUnique.mockResolvedValue({
      id: 10,
      userId: 1,
      business_name: 'Shop',
      rating: 5.0,
      user: { id: 1 },
    });
    prisma.booking.count.mockResolvedValue(1);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: 100, amount: 100 },
    });

    await getVendorProfile(req, res);

    expect(prisma.booking.count).toHaveBeenCalledTimes(1);
    expect(prisma.payment.aggregate).toHaveBeenCalledTimes(1);

    // Verify correct filter conditions are passed
    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: {
        service: { vendorId: 1 },
        status: { in: ['completed', 'confirmed', 'ongoing'] },
      },
    });
    expect(prisma.payment.aggregate).toHaveBeenCalledWith({
      where: {
        status: 'success',
        booking: {
          service: { vendorId: 1 },
          status: { in: ['completed', 'confirmed', 'ongoing'] },
        },
      },
      _sum: { vendorAmount: true, amount: true },
    });
  });

  // --- Edge case: profile fields are spread correctly into response ---
  it('should spread all vendor profile fields into the response', async () => {
    const req = mockReq();
    const res = mockRes();

    const profileData = {
      id: 10,
      userId: 1,
      business_name: 'Test Shop',
      phone: '9999999999',
      city: 'Mumbai',
      is_online: true,
      rating: 0,
      user: { id: 1, name: 'Vendor User' },
    };

    prisma.vendorProfile.findUnique.mockResolvedValue(profileData);
    prisma.booking.count.mockResolvedValue(0);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { vendorAmount: null, amount: null },
    });

    await getVendorProfile(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.id).toBe(10);
    expect(response.business_name).toBe('Test Shop');
    expect(response.phone).toBe('9999999999');
    expect(response.city).toBe('Mumbai');
    expect(response.is_online).toBe(true);
    expect(response.user).toEqual({ id: 1, name: 'Vendor User' });
  });
});

/**
 * Payout readiness must be visible.
 *
 * A vendor with no VendorPayoutAccount cannot be paid — util/payoutHelper.js
 * throws on settlement. Onboarding deliberately does not fail when RazorpayX
 * setup errors (a gateway outage shouldn't discard the vendor's documents),
 * but the failure used to be swallowed into a console.error and a plain
 * success response, so nobody learned about it until a payout failed days
 * later. These tests pin the reporting in place.
 */
describe('getVendorProfile — payout readiness reporting', () => {
  const baseProfile = {
    id: 10,
    userId: 1,
    business_name: 'Test Shop',
    rating: 4.25,
    numReviews: 4,
    user: { id: 1 },
  };

  beforeEach(() => {
    prisma.vendorProfile.findUnique.mockResolvedValue(baseProfile);
    prisma.booking.count.mockResolvedValue(0);
    prisma.payment.aggregate.mockResolvedValue({ _sum: { vendorAmount: null, amount: null } });
  });

  test('reports configured when an active payout account exists', async () => {
    prisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 1, isActive: true });

    const res = mockRes();
    await getVendorProfile(mockReq(), res);

    expect(res.json.mock.calls[0][0].payoutSetup).toEqual({ ok: true, configured: true });
  });

  test('reports the vendor as un-payable when no payout account exists', async () => {
    prisma.vendorPayoutAccount.findUnique.mockResolvedValue(null);

    const res = mockRes();
    await getVendorProfile(mockReq(), res);

    expect(res.json.mock.calls[0][0].payoutSetup).toEqual({
      ok: false, configured: false, reason: 'no_payout_account',
    });
  });

  test('reports an inactive payout account as un-payable', async () => {
    prisma.vendorPayoutAccount.findUnique.mockResolvedValue({ vendorId: 1, isActive: false });

    const res = mockRes();
    await getVendorProfile(mockReq(), res);

    expect(res.json.mock.calls[0][0].payoutSetup).toEqual({
      ok: false, configured: false, reason: 'payout_account_inactive',
    });
  });
});

/**
 * The onboarding flag must actually be persisted.
 *
 * updateVendorProfile destructures `onboarding_completed` from req.body but
 * never copied it into the `updates` object handed to Prisma, so the column
 * stayed false forever and resolveVendorLanding bounced already-onboarded
 * vendors back into onboarding on every login.
 */
describe('updateVendorProfile — onboarding_completed persistence', () => {
  test('writes onboarding_completed into the prisma update data', async () => {
    const req = mockReq({ body: { onboarding_completed: true } });
    const res = mockRes();

    await updateVendorProfile(req, res);

    expect(prisma.vendorProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 1 },
        data: expect.objectContaining({ onboarding_completed: true }),
      })
    );
  });

  test('promotes the user role to vendor when onboarding completes', async () => {
    const req = mockReq({ body: { onboarding_completed: true } });
    const res = mockRes();

    await updateVendorProfile(req, res);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { role: 'vendor' },
    });
  });

  test('does not touch onboarding_completed when the body omits it', async () => {
    const req = mockReq({ body: { business_name: 'Shop' } });
    const res = mockRes();

    await updateVendorProfile(req, res);

    const data = prisma.vendorProfile.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('onboarding_completed');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

// ─── bank_account_holder_name + Cloudinary uploads ──────────────────
// Two separate regressions, both silent data loss on write:
//
//  1. RazorpayX needs the *account holder's* name for a bank fund account;
//     payoutHelper was sending business_name. There was no column to hold
//     the real one, so it could never be captured.
//  2. uploadMiddleware uses multer.memoryStorage() and attaches the upload
//     result at `file.cloudinary.secure_url`. There is no `.path`, so every
//     `imageFiles[0].path` read wrote undefined and the image was lost.
describe('updateVendorProfile — payout holder name and image uploads', () => {

  test('writes bank_account_holder_name to the update data when sent', async () => {
    const req = mockReq({
      body: {
        bank_account_number: '1234567890',
        ifsc_code: 'HDFC0001234',
        bank_account_holder_name: 'Ramesh Kumar',
      },
    });
    const res = mockRes();

    await updateVendorProfile(req, res);

    const data = prisma.vendorProfile.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ bank_account_holder_name: 'Ramesh Kumar' });
  });

  test('stores the Cloudinary secure_url for an uploaded profile image', async () => {
    const req = mockReq({
      body: {},
      files: {
        image: [{ cloudinary: { secure_url: 'https://res.cloudinary.com/x.jpg' } }],
      },
    });
    const res = mockRes();

    await updateVendorProfile(req, res);

    const data = prisma.vendorProfile.update.mock.calls[0][0].data;
    expect(data.image).toBe('https://res.cloudinary.com/x.jpg');
  });

  test('stores the Cloudinary secure_url for an uploaded cover image', async () => {
    const req = mockReq({
      body: {},
      files: {
        cover_image: [{ cloudinary: { secure_url: 'https://res.cloudinary.com/cover.jpg' } }],
      },
    });
    const res = mockRes();

    await updateVendorProfile(req, res);

    const data = prisma.vendorProfile.update.mock.calls[0][0].data;
    expect(data.cover_image).toBe('https://res.cloudinary.com/cover.jpg');
  });

  test('stores the Cloudinary secure_url for a single-file (req.file) upload', async () => {
    const req = mockReq({
      body: {},
      file: { cloudinary: { secure_url: 'https://res.cloudinary.com/single.jpg' } },
    });
    const res = mockRes();

    await updateVendorProfile(req, res);

    const data = prisma.vendorProfile.update.mock.calls[0][0].data;
    expect(data.image).toBe('https://res.cloudinary.com/single.jpg');
  });
});
