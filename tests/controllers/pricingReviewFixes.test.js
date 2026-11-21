import { jest } from '@jest/globals';

const findUnique = jest.fn();
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: { booking: { findUnique } } }));
jest.unstable_mockModule('../../services/pricingV2Service.js', () => ({
  MAX_CHECK_IN_PHOTOS: 10, MAX_REQUEST_PHOTOS: 10, PricingError: class extends Error {},
  checkIn: jest.fn(), completeWork: jest.fn(), getPricing: jest.fn(), addPhotos: jest.fn(),
  createBillLink: jest.fn(), getCustomerContact: jest.fn(), recordPartsUsed: jest.fn(),
  issueFinalBill: jest.fn(), requestExtraWork: jest.fn(), sendPricingError: jest.fn(),
  startInspection: jest.fn(), startWork: jest.fn(), voidFinalBill: jest.fn(),
}));

const { photoUploadPrecheck } = await import('../../middleware/photoUploadPrecheck.js');
const { isImageUpload } = await import('../../controllers/vendor/pricingController.js');
const { publicBaseUrl } = await import('../../util/publicBaseUrl.js');

const mkRes = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); return r; };
const run = async (booking, id = '5') => {
  findUnique.mockResolvedValue(booking);
  const res = mkRes(); const next = jest.fn();
  await photoUploadPrecheck({ params: { id }, user: { id: 9 } }, res, next);
  return { res, next };
};
const ok = { service: { vendorId: 9 }, bookingJob: { id: 1 }, bookingPhotos: [], extraWorkRequests: [] };
const full = Array.from({ length: 10 }, () => ({ kind: 'check_in', extraWorkRequestId: null }));

describe('photoUploadPrecheck', () => {
  beforeEach(() => findUnique.mockReset());
  it('400 on bad id', async () => {
    const { res, next } = await run(ok, 'abc');
    expect(res.status).toHaveBeenCalledWith(400); expect(next).not.toHaveBeenCalled();
  });
  it('404 when missing', async () => { expect((await run(null)).res.status).toHaveBeenCalledWith(404); });
  it('403 for another vendor', async () => {
    const { res } = await run({ ...ok, service: { vendorId: 1 } });
    expect(res.status).toHaveBeenCalledWith(403);
  });
  it('409 NOT_CHECKED_IN without a job', async () => {
    const { res } = await run({ ...ok, bookingJob: null });
    expect(res.json.mock.calls[0][0].code).toBe('NOT_CHECKED_IN');
  });
  it('409 PHOTO_LIMIT when full and no open request has room', async () => {
    const { res, next } = await run({ ...ok, bookingPhotos: full });
    expect(res.json.mock.calls[0][0].code).toBe('PHOTO_LIMIT'); expect(next).not.toHaveBeenCalled();
  });
  it('passes when check-in is full but an open request has room', async () => {
    const { next } = await run({ ...ok, bookingPhotos: full, extraWorkRequests: [{ id: 3, status: 'pending' }] });
    expect(next).toHaveBeenCalledWith();
  });
  it('passes for a valid booking', async () => { expect((await run(ok)).next).toHaveBeenCalledWith(); });
});

describe('isImageUpload', () => {
  const f = (c, mimetype) => ({ mimetype, cloudinary: { secure_url: 'https://x/y', resource_type: 'image', ...c } });
  it('accepts jpg/jpeg/png/webp', () => {
    for (const format of ['jpg', 'jpeg', 'png', 'webp']) expect(isImageUpload(f({ format }))).toBe(true);
  });
  it('rejects a PDF reported as an image resource', () => {
    expect(isImageUpload(f({ format: 'pdf' }))).toBe(false);
    expect(isImageUpload(f({}, 'application/pdf'))).toBe(false);
  });
  it('rejects missing url, raw resource, or no format/mimetype', () => {
    expect(isImageUpload(f({ secure_url: undefined, format: 'png' }))).toBe(false);
    expect(isImageUpload(f({ resource_type: 'raw', format: 'png' }))).toBe(false);
    expect(isImageUpload(f({}))).toBe(false);
  });
});

describe('publicBaseUrl', () => {
  const req = { protocol: 'http', get: () => 'internal:8080' };
  afterEach(() => { delete process.env.PUBLIC_BASE_URL; });
  it('falls back to request host', () => { expect(publicBaseUrl(req)).toBe('http://internal:8080'); });
  it('uses env and trims trailing slash', () => {
    process.env.PUBLIC_BASE_URL = 'https://api.keplix.co.in/';
    expect(publicBaseUrl(req)).toBe('https://api.keplix.co.in');
  });
});
