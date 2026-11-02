import { jest } from '@jest/globals';
import maintenanceMiddleware, { isMaintenanceMode } from '../../middleware/maintenanceMiddleware.js';

const makeRes = () => {
  const res = {};
  res.set = jest.fn(() => res);
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const run = (path) => {
  const res = makeRes();
  const next = jest.fn();
  maintenanceMiddleware({ path }, res, next);
  return { res, next };
};

describe('maintenanceMiddleware', () => {
  const saved = { mode: process.env.MAINTENANCE_MODE, msg: process.env.MAINTENANCE_MESSAGE };
  afterEach(() => {
    if (saved.mode === undefined) delete process.env.MAINTENANCE_MODE;
    else process.env.MAINTENANCE_MODE = saved.mode;
    if (saved.msg === undefined) delete process.env.MAINTENANCE_MESSAGE;
    else process.env.MAINTENANCE_MESSAGE = saved.msg;
  });

  it('passes everything through when off', () => {
    delete process.env.MAINTENANCE_MODE;
    const { res, next } = run('/accounts/auth/login');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('only treats the exact string "true" as on', () => {
    expect(isMaintenanceMode({ MAINTENANCE_MODE: 'true' })).toBe(true);
    expect(isMaintenanceMode({ MAINTENANCE_MODE: '1' })).toBe(false);
    expect(isMaintenanceMode({ MAINTENANCE_MODE: 'false' })).toBe(false);
    expect(isMaintenanceMode({})).toBe(false);
  });

  it('returns 503 MAINTENANCE with Retry-After when on', () => {
    process.env.MAINTENANCE_MODE = 'true';
    delete process.env.MAINTENANCE_MESSAGE;
    const { res, next } = run('/service_api/vendor/bookings');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(res.json.mock.calls[0][0].code).toBe('MAINTENANCE');
    expect(res.json.mock.calls[0][0].message).toMatch(/maintenance/i);
  });

  it('uses MAINTENANCE_MESSAGE when set', () => {
    process.env.MAINTENANCE_MODE = 'true';
    process.env.MAINTENANCE_MESSAGE = 'Back by 4 PM';
    const { res } = run('/x');
    expect(res.json.mock.calls[0][0].message).toBe('Back by 4 PM');
  });

  it.each(['/health', '/admin', '/admin/auth/login', '/api-docs/x'])('lets %s through when on', (path) => {
    process.env.MAINTENANCE_MODE = 'true';
    const { next } = run(path);
    expect(next).toHaveBeenCalled();
  });

  it('does not exempt look-alike paths', () => {
    process.env.MAINTENANCE_MODE = 'true';
    expect(run('/administrator').next).not.toHaveBeenCalled();
    expect(run('/healthz').next).not.toHaveBeenCalled();
  });
});
