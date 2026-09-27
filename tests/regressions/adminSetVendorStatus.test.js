import { jest } from '@jest/globals';
import { readFileSync } from 'fs';

/**
 * PATCH /admin/vendors/:id/status  (Admin/vendorController.setVendorStatus)
 *
 * The controller selected `shop_name` — a column that does not exist on
 * VendorProfile (it is `business_name`). Prisma rejected every query with
 * "Unknown field `shop_name` for select statement", so approving ANY vendor
 * answered 500. Approval is the only gate between a signup and a garage that
 * customers can find, so no new vendor could ever go live. The older test in
 * vendorAndCronGuards.test.js only grep'd the source for a status write, which
 * is why it stayed green.
 *
 * This test runs the handler with a mocked Prisma but checks every field the
 * handler selects against the REAL model in prisma/schema.prisma, so a wrong
 * column name fails here instead of in production.
 */

const mockPrisma = { vendorProfile: { findUnique: jest.fn(), update: jest.fn() } };
const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/logger.js', () => ({ default: mockLogger }));

const { setVendorStatus } = await import('../../controllers/Admin/vendorController.js');

const modelFields = (name) => {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  // The schema file may use Windows (\r\n) line endings, so match both.
  const start = schema.indexOf(`model ${name} {`);
  const end = schema.indexOf('\n}', start);
  const body = start === -1 || end === -1 ? '' : schema.slice(start, end);
  return new Set(
    body.split(/\r?\n/).slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('@@'))
      .map((l) => l.split(/\s+/)[0])
  );
};

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.vendorProfile.findUnique.mockResolvedValue({ id: 1, status: 'pending', business_name: 'Audit Garage' });
  mockPrisma.vendorProfile.update.mockResolvedValue({ userId: 5, status: 'approved', business_name: 'Audit Garage' });
});

const run = (body = { status: 'approved' }) => {
  const res = mockRes();
  return setVendorStatus({ params: { id: '5' }, body, user: { id: 1 } }, res).then(() => res);
};

describe('setVendorStatus', () => {
  test('approves a pending vendor', async () => {
    const res = await run();
    expect(mockPrisma.vendorProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 5 }, data: { status: 'approved' } })
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Vendor approved.' }));
  });

  test('only selects columns that exist on VendorProfile', async () => {
    await run();
    const real = modelFields('VendorProfile');
    expect(real.has('business_name')).toBe(true);

    const selects = [
      mockPrisma.vendorProfile.findUnique.mock.calls[0][0].select,
      mockPrisma.vendorProfile.update.mock.calls[0][0].select,
    ];
    for (const select of selects) {
      for (const field of Object.keys(select)) {
        expect({ field, exists: real.has(field) }).toEqual({ field, exists: true });
      }
    }
  });

  test('unknown vendor answers 404, and re-approving is a no-op 200', async () => {
    mockPrisma.vendorProfile.findUnique.mockResolvedValueOnce(null);
    const missing = await run();
    expect(missing.status).toHaveBeenCalledWith(404);

    mockPrisma.vendorProfile.findUnique.mockResolvedValueOnce({ id: 1, status: 'approved', business_name: 'X' });
    const again = await run();
    expect(mockPrisma.vendorProfile.update).not.toHaveBeenCalled();
    expect(again.status).toHaveBeenCalledWith(200);
  });
});
