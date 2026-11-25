import { jest } from '@jest/globals';

const mockPrisma = { user: { findMany: jest.fn(), count: jest.fn() } };
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));
jest.unstable_mockModule('../../util/cloudinary.js', () => ({ signPrivateUrl: (u) => u }));
jest.unstable_mockModule('../../util/subscription.js', () => ({ getOrCreateSubscription: jest.fn() }));

const { listVendorApprovals } = await import('../../controllers/Admin/vendorController.js');
const { parseApprovalsQuery } = await import('../../validators/Admin/vendorValidator.js');

const res = () => { const r = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
const profile = { business_name: 'G', owner_name: 'O', phone: '9', address: 'a', city: 'Pune', pincode: '1',
  latitude: 1, longitude: 2, operating_hours: '9-5', bank_account_number: '123456', ifsc_code: 'X', status: 'pending' };
const user = (id, over = {}, docs = [{ document_type: 'pan_card' }]) => ({
  id, email: `v${id}@x.in`, createdAt: new Date(`2026-11-0${id}T00:00:00Z`),
  vendorProfile: { ...profile, ...over }, documents: docs,
});
beforeEach(() => { jest.clearAllMocks(); mockPrisma.user.count.mockResolvedValue(2); });

test('parse: defaults, whitelist, caps and bad values', () => {
  expect(parseApprovalsQuery({}).value).toMatchObject({ status: 'pending', page: 1, limit: 20, onboarding: null });
  expect(parseApprovalsQuery({ status: 'bogus' }).error).toMatch(/status/);
  expect(parseApprovalsQuery({ limit: '9999' }).value.limit).toBe(50);
  expect(parseApprovalsQuery({ page: 'x' }).error).toMatch(/page/);
  expect(parseApprovalsQuery({ page: '-1' }).error).toMatch(/page/);
  expect(parseApprovalsQuery({ from: 'nope' }).error).toMatch(/from/);
  expect(parseApprovalsQuery({ from: '2026-11-05', to: '2026-11-01' }).error).toMatch(/not be after/);
  expect(parseApprovalsQuery({ onboarding: 'maybe' }).error).toMatch(/onboarding/);
  expect(parseApprovalsQuery({ to: '2026-11-05' }).value.to.toISOString()).toBe('2026-11-05T23:59:59.999Z');
});

test('invalid params -> 400 and no query', async () => {
  const r = res();
  await listVendorApprovals({ query: { status: 'x' } }, r);
  expect(r.status).toHaveBeenCalledWith(400);
  expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
});

test('defaults to pending, newest first, one query with pagination and meta', async () => {
  mockPrisma.user.findMany.mockResolvedValue([user(2), user(1)]);
  const r = res();
  await listVendorApprovals({ query: { page: '2', limit: '10' } }, r);
  const arg = mockPrisma.user.findMany.mock.calls[0][0];
  expect(arg.where).toEqual({ role: 'vendor', vendorProfile: { is: { status: 'pending' } } });
  expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  expect(arg.skip).toBe(10); expect(arg.take).toBe(10);
  expect(mockPrisma.user.findMany).toHaveBeenCalledTimes(1);
  const body = r.json.mock.calls[0][0];
  expect(body.meta).toEqual({ page: 2, limit: 10, total: 2, totalPages: 1 });
  expect(body.data[0]).toMatchObject({ id: 2, business: 'G', documentsCount: 1, onboardingComplete: true });
  expect(JSON.stringify(body)).not.toMatch(/123456/); // no bank data in list
});

test('status all, city, dates and search build the where clause', async () => {
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.user.count.mockResolvedValue(0);
  await listVendorApprovals({ query: { status: 'all', city: ' Pune ', from: '2026-11-01', to: '2026-11-30', q: 'raj' } }, res());
  const { where } = mockPrisma.user.findMany.mock.calls[0][0];
  expect(where.vendorProfile).toEqual({ is: { city: { equals: 'Pune', mode: 'insensitive' } } });
  expect(where.createdAt.gte).toEqual(new Date('2026-11-01'));
  expect(where.createdAt.lte.toISOString()).toBe('2026-11-30T23:59:59.999Z');
  expect(where.OR).toHaveLength(4);
});

test('onboarding filter scans then pages in memory', async () => {
  mockPrisma.user.findMany.mockResolvedValue([user(3, {}, []), user(2), user(1, { city: '' })]);
  const r = res();
  await listVendorApprovals({ query: { onboarding: 'incomplete', limit: '1', page: '2' } }, r);
  expect(mockPrisma.user.count).not.toHaveBeenCalled();
  const body = r.json.mock.calls[0][0];
  expect(body.meta).toMatchObject({ total: 2, totalPages: 2, page: 2 });
  expect(body.data.map((x) => x.id)).toEqual([1]);

  mockPrisma.user.findMany.mockResolvedValue([user(3, {}, []), user(2)]);
  const r2 = res();
  await listVendorApprovals({ query: { onboarding: 'complete' } }, r2);
  expect(r2.json.mock.calls[0][0].data.map((x) => x.id)).toEqual([2]);
});

test('db error -> 500 without leaking details', async () => {
  mockPrisma.user.findMany.mockRejectedValue(new Error('secret db'));
  mockPrisma.user.count.mockResolvedValue(0);
  const r = res();
  await listVendorApprovals({ query: {} }, r);
  expect(r.status).toHaveBeenCalledWith(500);
  expect(JSON.stringify(r.json.mock.calls[0][0])).not.toMatch(/secret/);
});
