/**
 * Security A-006: OTP-bearing SMS/WhatsApp bodies must not be written to logs
 * outside local development.
 */
import { jest } from '@jest/globals';

const info = jest.fn();
jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info, warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../util/firebase.js', () => ({ messaging: null, default: {} }));

const { sendSMS, sendWhatsApp, redactForLog } = await import('../../util/communication.js');

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; info.mockClear(); });

const noTwilio = () => {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_API_KEY_SID;
  delete process.env.TWILIO_API_KEY_SECRET;
};

test('production: mock SMS log never contains the body', async () => {
  noTwilio();
  process.env.NODE_ENV = 'production';
  await sendSMS('+919876543210', 'Your Keplix code is 482913');
  const logged = info.mock.calls.map((c) => c[0]).join('\n');
  expect(logged).not.toContain('482913');
  expect(logged).toContain('[redacted');
});

test('production: mock WhatsApp log never contains the variables', async () => {
  noTwilio();
  process.env.NODE_ENV = 'production';
  await sendWhatsApp('+919876543210', 'HX1', { 1: 'secret-link-token' });
  const logged = info.mock.calls.map((c) => c[0]).join('\n');
  expect(logged).not.toContain('secret-link-token');
});

test('development keeps the body for local debugging', () => {
  process.env.NODE_ENV = 'development';
  expect(redactForLog('code 1')).toBe('code 1');
  process.env.NODE_ENV = 'test';
  expect(redactForLog('code 1')).toBe('[redacted 6 chars]');
});
