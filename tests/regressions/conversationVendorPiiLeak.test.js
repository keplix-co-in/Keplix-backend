/**
 * Regression tests for the CONFIRMED PII leak in both conversation-list
 * endpoints, found by the 2026-09-12 codebase audit (security-auditor F7).
 *
 * `controllers/user/interactionController.js`'s `getConversations` and
 * `controllers/vendor/interactionController.js`'s `getVendorConversations`
 * both did `vendor: { include: { vendorProfile: true } } }` and
 * `user: { include: { userProfile: true } }`, then returned the fetched
 * objects verbatim. Prisma `include` on a relation returns every scalar
 * column of that row, so this shipped the vendor's bank_account_number,
 * ifsc_code, upi_id, bank_account_holder_name and password hash to whichever
 * customer they'd messaged, and the customer's own password hash to
 * whichever vendor they'd messaged.
 *
 * The fix: `vendor: PUBLIC_VENDOR_INCLUDE` (the allow-list already used on
 * public service-listing endpoints) plus `stripVendorSecrets()` on the way
 * out, per util/publicVendor.js's own documented "use both" convention.
 *
 * See tests/regressions/vendorPiiLeak.test.js (the endpoint this pattern was
 * first fixed on) and bookingStatusGuards.test.js for the file convention.
 */
import { jest } from '@jest/globals';

const VENDOR_SECRET_FIELDS = ['password', 'bank_account_number', 'ifsc_code', 'upi_id', 'bank_account_holder_name'];

const conversationRow = (overrides = {}) => ({
  id: 1,
  updatedAt: new Date(),
  messages: [],
  booking: {
    id: 100,
    user: {
      id: 501,
      email: 'customer@example.com',
      password: '$2a$10$customerHashShouldNeverLeave', // the customer's own hash
      userProfile: { id: 10, name: 'Customer' },
    },
    service: {
      id: 200,
      vendor: {
        id: 601,
        role: 'vendor',
        password: '$2a$10$vendorHashShouldNeverLeave', // the vendor's own hash
        vendorProfile: {
          business_name: 'Joe\'s Garage',
          bank_account_number: '000111222333',
          ifsc_code: 'HDFC0001234',
          upi_id: 'joe@upi',
          bank_account_holder_name: 'Joe Vendor',
        },
      },
    },
    ...overrides.booking,
  },
  ...overrides,
});

const assertNoSecretsAnywhere = (value) => {
  if (Array.isArray(value)) return value.forEach(assertNoSecretsAnywhere);
  if (!value || typeof value !== 'object') return;
  for (const field of VENDOR_SECRET_FIELDS) {
    expect(Object.keys(value)).not.toContain(field);
  }
  Object.values(value).forEach(assertNoSecretsAnywhere);
};

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: { conversation: { findMany: jest.fn() } },
}));
jest.unstable_mockModule('../../socket.js', () => ({ getIO: jest.fn() }));
jest.unstable_mockModule('../../util/notificationHelper.js', () => ({ createNotification: jest.fn() }));
jest.unstable_mockModule('../../util/notificationTemplates.js', () => ({
  renderNotification: jest.fn(),
  NOTIFICATION_TYPES: {},
}));

const prisma = (await import('../../util/prisma.js')).default;
const { getConversations } = await import('../../controllers/user/interactionController.js');

describe('conversation-list PII leak — FIXED, regression guard', () => {
  test('customer-side getConversations: response contains no vendor banking fields or password hashes anywhere', async () => {
    prisma.conversation.findMany.mockResolvedValue([conversationRow()]);

    const req = { user: { id: 501 }, query: {} };
    const res = { json: jest.fn() };

    await getConversations(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.data.length).toBe(1);
    assertNoSecretsAnywhere(body.data);
  });
});
