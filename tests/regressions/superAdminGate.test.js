/**
 * Regression test for audit #108: destructive/money-moving admin routes
 * (refund, payout settlement, force-complete, account deletion) had no
 * privilege separation from ordinary admin read/write routes.
 *
 * `authorizeSuperAdmin` is mounted after `authAdmin` + `authorizeAdmin` on
 * those specific routes only (routes/Admin/finance.js, bookings.js, user.js).
 */
import { jest } from '@jest/globals';

const { authorizeSuperAdmin } = await import('../../middleware/authAdminMiddleware.js');

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('authorizeSuperAdmin', () => {
  test('rejects a plain "admin" role', () => {
    const req = { user: { id: 1, role: 'admin' } };
    const res = mockRes();
    const next = jest.fn();

    authorizeSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects when req.user is missing', () => {
    const res = mockRes();
    const next = jest.fn();

    authorizeSuperAdmin({}, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('allows "super_admin"', () => {
    const req = { user: { id: 1, role: 'super_admin' } };
    const next = jest.fn();

    authorizeSuperAdmin(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
  });
});
