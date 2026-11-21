/**
 * Pricing v2 request schemas (validators/pricingV2Validators.js) and the admin
 * rollout switch PlatformSettings.pricingV2From.
 */
import { jest } from '@jest/globals';

const mockPrisma = { platformSettings: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));

const { checkInSchema, extraWorkSchema, voidBillSchema, decisionSchema } = await import('../../validators/pricingV2Validators.js');
const { updatePlatformSettingsSchema } = await import('../../validators/Admin/platformSettingsValidator.js');
const { updatePlatformSettingsAdmin } = await import('../../controllers/Admin/platformSettingsController.js');

const ok = (schema, v) => schema.safeParse(v).success;

describe('checkInSchema', () => {
  test('all fields optional; an empty body is valid', () => {
    expect(ok(checkInSchema, {})).toBe(true);
    expect(ok(checkInSchema, { odometer_km: 42000, fuel_level: 'half', condition_note: 'Scratch on bumper' })).toBe(true);
  });
  test('rejects a negative odometer and an unknown fuel level', () => {
    expect(ok(checkInSchema, { odometer_km: -1 })).toBe(false);
    expect(ok(checkInSchema, { fuel_level: 'brimming' })).toBe(false);
  });
});

describe('extraWorkSchema', () => {
  const part = { kind: 'part', name: 'Rotor', qty: 2, unit_price: 1800 };
  test('a part/labour item needs name, qty and unit_price', () => {
    expect(ok(extraWorkSchema, { reason: 'Rotors worn', items: [part] })).toBe(true);
    expect(ok(extraWorkSchema, { reason: 'Rotors worn', items: [{ kind: 'part', name: 'Rotor' }] })).toBe(false);
  });
  test('a removal needs the quote line it removes, nothing else', () => {
    expect(ok(extraWorkSchema, { reason: 'Not needed', items: [{ kind: 'removal', quote_line_id: 5 }] })).toBe(true);
    expect(ok(extraWorkSchema, { reason: 'Not needed', items: [{ kind: 'removal' }] })).toBe(false);
  });
  test('reason length and item count are bounded', () => {
    expect(ok(extraWorkSchema, { reason: 'x', items: [part] })).toBe(false);
    expect(ok(extraWorkSchema, { reason: 'Rotors worn', items: [] })).toBe(false);
    expect(ok(extraWorkSchema, { reason: 'Rotors worn', items: Array(21).fill(part) })).toBe(false);
  });
});

describe('voidBillSchema / decisionSchema', () => {
  test('void needs a reason', () => {
    expect(ok(voidBillSchema, { reason: 'Wrong part price' })).toBe(true);
    expect(ok(voidBillSchema, {})).toBe(false);
  });
  test('decision needs at least one id and no id in both lists', () => {
    expect(ok(decisionSchema, { approve: [1], reject: [2] })).toBe(true);
    expect(ok(decisionSchema, { approve: [], reject: [] })).toBe(false);
    expect(ok(decisionSchema, { approve: [1], reject: [1] })).toBe(false);
  });
});

describe('admin pricingV2From switch', () => {
  test('schema accepts an ISO instant or null', () => {
    expect(ok(updatePlatformSettingsSchema, { pricingV2From: '2026-12-01T00:00:00Z' })).toBe(true);
    expect(ok(updatePlatformSettingsSchema, { pricingV2From: null })).toBe(true);
    expect(ok(updatePlatformSettingsSchema, { pricingV2From: 'tomorrow' })).toBe(false);
  });

  test('controller stores a Date, null clears it, absent leaves it alone', async () => {
    mockPrisma.platformSettings.findFirst.mockResolvedValue({ id: 1 });
    mockPrisma.platformSettings.update.mockResolvedValue({ id: 1 });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await updatePlatformSettingsAdmin({ body: { pricingV2From: '2026-12-01T00:00:00Z' } }, res);
    expect(mockPrisma.platformSettings.update.mock.calls[0][0].data.pricingV2From).toEqual(new Date('2026-12-01T00:00:00Z'));

    await updatePlatformSettingsAdmin({ body: { pricingV2From: null } }, res);
    expect(mockPrisma.platformSettings.update.mock.calls[1][0].data.pricingV2From).toBeNull();

    await updatePlatformSettingsAdmin({ body: { isPlatformFeeEnabled: true } }, res);
    expect(mockPrisma.platformSettings.update.mock.calls[2][0].data).not.toHaveProperty('pricingV2From');
  });
});
