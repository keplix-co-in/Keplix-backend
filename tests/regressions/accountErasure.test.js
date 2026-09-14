/**
 * Regression tests for the CONFIRMED absence of any GDPR erasure or
 * export path, found by the 2026-09-12 codebase audit (compliance-auditor
 * F11, project-manager F19, product-manager F22, compliance-auditor F48).
 *
 * Before this fix: the only account-removal code was Admin/userController's
 * deleteUser, which for any account with booking history did nothing but
 * flip is_active to false -- UserProfile (name, phone, address,
 * id_proof_front/back), the User's own fcmToken/pushToken, PhoneIdentity,
 * claimed WalkInJob customer fields and uploaded Cloudinary documents all
 * stayed exactly as they were. There was no user-initiated deletion route
 * and no data-export route at all.
 *
 * See tests/regressions/bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  userProfile: { update: jest.fn() },
  phoneIdentity: { deleteMany: jest.fn(), findUnique: jest.fn() },
  vehicle: { updateMany: jest.fn(), findMany: jest.fn() },
  walkInJob: { updateMany: jest.fn(), findMany: jest.fn() },
  booking: { findMany: jest.fn() },
  payment: { findMany: jest.fn() },
  bookingVehicle: { findMany: jest.fn() },
  healthSheet: { findMany: jest.fn() },
  review: { findMany: jest.fn() },
  message: { findMany: jest.fn() },
  notification: { findMany: jest.fn() },
  feedback: { findMany: jest.fn() },
};

const mockDestroyAsset = jest.fn();

jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('../../util/cloudinary.js', () => ({
  destroyAsset: mockDestroyAsset,
  publicIdFromUrl: (url) => (url ? `media_uploads/${url.split('/').pop().split('.')[0]}` : null),
}));

const { eraseUserPii } = await import('../../services/accountErasureService.js');
const { deleteUserAccount, exportUserData } = await import('../../controllers/user/profileController.js');

const USER_ID = 501;
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDestroyAsset.mockResolvedValue(true);
  mockPrisma.userProfile.update.mockResolvedValue({});
  mockPrisma.user.update.mockResolvedValue({});
  mockPrisma.phoneIdentity.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.walkInJob.updateMany.mockResolvedValue({ count: 0 });
});

describe('eraseUserPii — FIXED, regression guard', () => {
  test('throws a 404-flagged error when the user does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(eraseUserPii(USER_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('redacts UserProfile name/phone/address/id-proof/profile-picture', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      userProfile: {
        name: 'Real Name', phone: '+911234567890', address: '123 Real St',
        id_proof_front: 'https://res.cloudinary.com/x/upload/v1/media_uploads/id_proof_front-abc.jpg',
        id_proof_back: 'https://res.cloudinary.com/x/upload/v1/media_uploads/id_proof_back-abc.jpg',
        profile_picture: 'https://res.cloudinary.com/x/upload/v1/media_uploads/profile_picture-abc.jpg',
      },
    });

    await eraseUserPii(USER_ID);

    expect(mockPrisma.userProfile.update).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      data: {
        name: 'Deleted User', phone: null, address: null,
        id_proof_front: null, id_proof_back: null, profile_picture: null,
      },
    });
  });

  test('deletes the actual Cloudinary assets, not just the DB column', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      userProfile: {
        profile_picture: 'https://res.cloudinary.com/x/upload/v1/media_uploads/profile_picture-abc.jpg',
        id_proof_front: null,
        id_proof_back: null,
      },
    });

    const result = await eraseUserPii(USER_ID);

    expect(mockDestroyAsset).toHaveBeenCalledWith('media_uploads/profile_picture-abc');
    expect(result.assetsDeleted).toBe(1);
  });

  test('rewrites email to a non-colliding placeholder and clears device tokens, without hard-deleting the User row', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, userProfile: null });

    await eraseUserPii(USER_ID);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        email: `deleted-${USER_ID}@invalid`,
        fcmToken: null,
        pushToken: null,
        is_active: false,
      },
    });
  });

  test('deletes the PhoneIdentity row (field is NOT NULL + unique, so it cannot be redacted in place)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, userProfile: null });

    await eraseUserPii(USER_ID);

    expect(mockPrisma.phoneIdentity.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  test('redacts owner_phone/owner_name on vehicles this account owns, not ownerUserId itself', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, userProfile: null });
    mockPrisma.vehicle.updateMany.mockResolvedValue({ count: 2 });

    const result = await eraseUserPii(USER_ID);

    expect(mockPrisma.vehicle.updateMany).toHaveBeenCalledWith({
      where: { ownerUserId: USER_ID },
      data: { owner_phone: null, owner_name: null },
    });
    expect(result.vehiclesRedacted).toBe(2);
  });

  test('redacts customer_name/customer_phone on WalkInJobs this account has claimed, not unclaimed ones', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, userProfile: null });
    mockPrisma.walkInJob.updateMany.mockResolvedValue({ count: 1 });

    await eraseUserPii(USER_ID);

    expect(mockPrisma.walkInJob.updateMany).toHaveBeenCalledWith({
      where: { claimedByUserId: USER_ID },
      data: { customer_name: 'Deleted Customer', customer_phone: '0000000000' },
    });
  });
});

describe('DELETE /service_api/user/:userId/account — FIXED, regression guard', () => {
  test('refuses to erase an account that is not the caller\'s own', async () => {
    const req = { params: { userId: String(USER_ID) }, user: { id: 999 } };
    const res = mockRes();

    await deleteUserAccount(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('erases the caller\'s own account and returns the erasure summary', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, userProfile: null });
    const req = { params: { userId: String(USER_ID) }, user: { id: USER_ID } };
    const res = mockRes();

    await deleteUserAccount(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ erasure: expect.objectContaining({ deactivated: true }) })
    );
  });
});

describe('GET /service_api/user/:userId/export — FIXED, regression guard', () => {
  beforeEach(() => {
    mockPrisma.booking.findMany.mockResolvedValue([]);
    mockPrisma.payment.findMany.mockResolvedValue([]);
    mockPrisma.bookingVehicle.findMany.mockResolvedValue([]);
    mockPrisma.healthSheet.findMany.mockResolvedValue([]);
    mockPrisma.review.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.notification.findMany.mockResolvedValue([]);
    mockPrisma.feedback.findMany.mockResolvedValue([]);
    mockPrisma.vehicle.findMany.mockResolvedValue([]);
    mockPrisma.walkInJob.findMany.mockResolvedValue([]);
    mockPrisma.phoneIdentity.findUnique.mockResolvedValue(null);
  });

  test('refuses to export data for an account that is not the caller\'s own', async () => {
    const req = { params: { userId: String(USER_ID) }, user: { id: 999 } };
    const res = mockRes();

    await exportUserData(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  test('returns a JSON bundle covering bookings, payments, reviews, messages, notifications, feedback, vehicles and walk-in history', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: 'x@y.com' });
    const req = { params: { userId: String(USER_ID) }, user: { id: USER_ID } };
    const res = mockRes();

    await exportUserData(req, res);

    const body = res.json.mock.calls[0][0];
    for (const key of [
      'account', 'bookings', 'payments', 'bookingVehicles', 'healthSheets',
      'reviews', 'messages', 'notifications', 'feedback', 'vehicles', 'walkInJobs', 'phoneIdentity',
    ]) {
      expect(body).toHaveProperty(key);
    }
  });

  test('payment export excludes internal payout/gateway-fee fields', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: 'x@y.com' });
    const req = { params: { userId: String(USER_ID) }, user: { id: USER_ID } };
    await exportUserData(req, mockRes());

    const paymentSelect = mockPrisma.payment.findMany.mock.calls[0][0].select;
    expect(paymentSelect).not.toHaveProperty('vendorPayoutId');
    expect(paymentSelect).not.toHaveProperty('gatewayFee');
  });
});
