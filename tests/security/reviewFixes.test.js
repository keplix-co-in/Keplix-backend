// Review fixes on top of the 2026-11 security batch: regressions that would
// have broken live clients. See the "Review fix" comments in the sources.
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    document: { create: jest.fn(), findMany: jest.fn() },
    vendorProfile: { findUnique: jest.fn(), update: jest.fn() },
  },
}));
jest.unstable_mockModule('../../util/payoutHelper.js', () => ({
  setupVendorPayoutAccount: jest.fn(),
  updateVendorPayoutAccount: jest.fn(),
}));

const prisma = (await import('../../util/prisma.js')).default;
const { uploadDocument } = await import('../../controllers/vendor/documentController.js');
const { isRequiredKycDocumentType } = await import('../../controllers/vendor/profileController.js');
const { clampLimit } = await import('../../util/parsePagination.js');
const { tokenRoom, disconnectTokenSockets } = await import('../../util/socketSessions.js');
const { UPLOAD_LIMITS } = await import('../../middleware/uploadMiddleware.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('onboarding flag completes when the PAN lands (web portal uploads PAN after the profile)', () => {
  const req = (type) => ({
    user: { id: 7 },
    body: { document_type: type },
    file: { cloudinary: { secure_url: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg' } },
  });

  test('pan_card upload flips a filled-in profile to onboarded', async () => {
    prisma.document.create.mockResolvedValue({ id: 1, file_url: 'https://res.cloudinary.com/x/image/upload/v1/a.jpg' });
    prisma.vendorProfile.findUnique.mockResolvedValue({ onboarding_completed: false, business_name: 'Shop' });
    prisma.document.findMany.mockResolvedValue([{ document_type: 'pan_card' }]);
    const res = mockRes();
    await uploadDocument(req('pan_card'), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(prisma.vendorProfile.update).toHaveBeenCalledWith({ where: { userId: 7 }, data: { onboarding_completed: true } });
  });

  test('no flip without a business name, or for non-KYC documents', async () => {
    prisma.document.create.mockResolvedValue({ id: 1, file_url: null });
    prisma.vendorProfile.findUnique.mockResolvedValue({ onboarding_completed: false, business_name: null });
    prisma.document.findMany.mockResolvedValue([{ document_type: 'pan_card' }]);
    await uploadDocument(req('pan_card'), mockRes());
    await uploadDocument(req('trade_license'), mockRes());
    expect(prisma.vendorProfile.update).not.toHaveBeenCalled();
  });

  test('a failing flag update never fails the upload', async () => {
    prisma.document.create.mockResolvedValue({ id: 1, file_url: null });
    prisma.vendorProfile.findUnique.mockRejectedValue(new Error('db down'));
    const res = mockRes();
    await uploadDocument(req('pan'), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('PAN aliases', () => {
    expect(isRequiredKycDocumentType('pan_card')).toBe(true);
    expect(isRequiredKycDocumentType(' PAN ')).toBe(true);
    expect(isRequiredKycDocumentType('aadhar_card')).toBe(false);
  });
});

describe('pagination caps for own-row lists', () => {
  test('default cap stays 100; an explicit max raises it', () => {
    expect(clampLimit(1000)).toBe(100);
    expect(clampLimit(1000, 50, 1000)).toBe(1000);
    expect(clampLimit(5000, 50, 1000)).toBe(1000);
    expect(clampLimit(undefined, 50, 1000)).toBe(50);
  });
});

describe('logout socket teardown is per token', () => {
  test('different tokens map to different rooms; only that room is disconnected', () => {
    expect(tokenRoom('a')).not.toBe(tokenRoom('b'));
    expect(tokenRoom('a')).toMatch(/^token_[0-9a-f]{32}$/);
    const disconnectSockets = jest.fn();
    const io = { in: jest.fn(() => ({ disconnectSockets })) };
    expect(disconnectTokenSockets(io, 'a')).toBe(true);
    expect(io.in).toHaveBeenCalledWith(tokenRoom('a'));
    expect(disconnectTokenSockets(io, '')).toBe(false);
  });
});

test('upload file cap fits a 20-item health sheet at 2 photos each', () => {
  expect(UPLOAD_LIMITS.files).toBeGreaterThanOrEqual(40);
});
