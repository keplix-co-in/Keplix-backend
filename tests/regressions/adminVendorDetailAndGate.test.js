import { jest } from '@jest/globals';

const mockPrisma = {
  vendorProfile: { findUnique: jest.fn(), update: jest.fn() },
  document: { findMany: jest.fn() },
  user: { findFirst: jest.fn() },
  service: { count: jest.fn() },
};
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));
jest.unstable_mockModule('../../util/cloudinary.js', () => ({ signPrivateUrl: (u) => `signed:${u}` }));
jest.unstable_mockModule('../../util/subscription.js', () => ({ getOrCreateSubscription: jest.fn() }));

const { setVendorStatus, getVendorDetail } = await import('../../controllers/Admin/vendorController.js');
const { computeOnboarding, maskTail } = await import('../../util/vendorOnboarding.js');

const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const full = {
  id: 1, status: 'pending', business_name: 'G', owner_name: 'O', phone: '9', address: 'a', city: 'c', pincode: '1',
  latitude: 1, longitude: 2, operating_hours: '9-5', bank_account_number: '1234567890', ifsc_code: 'X', upi_id: 'me@upi',
};
beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.document.findMany.mockResolvedValue([{ id: 1, document_type: 'pan', file_url: 'u1', status: 'pending' }]);
});

test('computeOnboarding lists missing fields; pan alias counts', () => {
  expect(computeOnboarding(full, [{ document_type: 'PAN' }])).toEqual({ complete: true, missing: [] });
  const r = computeOnboarding({ ...full, city: '', latitude: null }, []);
  expect(r.missing).toEqual(expect.arrayContaining(['city', 'location', 'document:pan_card']));
});

test('maskTail keeps last 4 only', () => {
  expect(maskTail('1234567890')).toMatch(/^\*+7890$/);
  expect(maskTail(null)).toBeNull();
});

test('approve refused 400 ONBOARDING_INCOMPLETE when fields/docs missing', async () => {
  mockPrisma.vendorProfile.findUnique.mockResolvedValue({ ...full, city: null });
  const r = res();
  await setVendorStatus({ params: { id: '5' }, body: { status: 'approved' }, user: { id: 1 } }, r);
  expect(r.status).toHaveBeenCalledWith(400);
  expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ONBOARDING_INCOMPLETE', missing: ['city'] }));
  expect(mockPrisma.vendorProfile.update).not.toHaveBeenCalled();
});

test('reject is not gated by onboarding', async () => {
  mockPrisma.vendorProfile.findUnique.mockResolvedValue({ ...full, city: null });
  mockPrisma.vendorProfile.update.mockResolvedValue({ userId: 5, status: 'rejected' });
  const r = res();
  await setVendorStatus({ params: { id: '5' }, body: { status: 'rejected', reason: 'bad docs' }, user: { id: 1 } }, r);
  expect(mockPrisma.vendorProfile.update).toHaveBeenCalled();
});

test('detail returns masked bank, signed docs, onboarding; 404 for unknown', async () => {
  mockPrisma.user.findFirst.mockResolvedValue({ id: 5, email: 'a@b.c', is_verified: true, is_active: true, createdAt: new Date(), vendorProfile: full });
  mockPrisma.service.count.mockResolvedValue(3);
  const r = res();
  await getVendorDetail({ params: { id: '5' } }, r);
  const { data } = r.json.mock.calls[0][0];
  expect(data.bank.accountNumber).toMatch(/7890$/);
  expect(data.bank.accountNumber).not.toContain('123456');
  expect(data.documents[0].url).toBe('signed:u1');
  expect(data.servicesCount).toBe(3);
  expect(data.onboarding.complete).toBe(true);

  mockPrisma.user.findFirst.mockResolvedValue(null);
  const r2 = res();
  await getVendorDetail({ params: { id: '9' } }, r2);
  expect(r2.status).toHaveBeenCalledWith(404);
});
