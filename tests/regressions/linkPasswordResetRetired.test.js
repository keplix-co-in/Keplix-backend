import { jest } from '@jest/globals';

/**
 * The link-based password reset is retired (uniform 410).
 *
 * It used to write `resetPasswordToken` / `resetPasswordExpires`, columns User
 * has never had: a real account got 500 while an unknown email got a friendly
 * 200 — so it was both broken and an oracle for "is this email registered?".
 * Whatever the email, the answer must now be identical and touch nothing.
 */

process.env.JWT_SECRET = 'test_access_secret';
const mockPrisma = { user: { findUnique: jest.fn(), update: jest.fn(), findFirst: jest.fn() } };
jest.unstable_mockModule('../../util/prisma.js', () => ({ default: mockPrisma }));
jest.unstable_mockModule('../../util/firebase.js', () => ({
  default: { auth: () => ({ verifyIdToken: jest.fn() }) },
  messaging: null,
}));
jest.unstable_mockModule('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
}));

const { forgotPassword, resetPassword } = await import('../../controllers/authController.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('link-based password reset is retired', () => {
  test('forgotPassword answers 410 identically for known and unknown emails, and touches nothing', async () => {
    const known = mockRes();
    const unknown = mockRes();
    await forgotPassword({ body: { email: 'real@example.com' } }, known);
    await forgotPassword({ body: { email: 'ghost@example.com' } }, unknown);

    expect(known.status).toHaveBeenCalledWith(410);
    expect(unknown.status).toHaveBeenCalledWith(410);
    expect(known.json.mock.calls[0][0]).toEqual(unknown.json.mock.calls[0][0]);
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  test('resetPassword answers 410 and touches nothing', async () => {
    const res = mockRes();
    await resetPassword({ params: { token: 'abc' }, body: { password: 'x', re_password: 'x' } }, res);
    expect(res.status).toHaveBeenCalledWith(410);
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
