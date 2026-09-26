/**
 * Regression test for the CORS-blocked response shape (audit #173).
 *
 * A request from a disallowed Origin used to surface as HTTP 500
 * {"success":false,"message":"CORS blocked for origin: https://evil.example"}
 * — the origin callback put the origin inside err.message and set no
 * statusCode, so errorHandler fell through to its 500 default and echoed the
 * attacker-controlled origin straight back. A blocked preflight is a client
 * mistake, not a server failure.
 *
 * This pins the contract: 403, code CORS_BLOCKED, a fixed generic message
 * that does not contain the origin, and no stack in the body.
 *
 * See tests/regressions/jwtTypeConfusion.test.js for the file convention.
 */
import { jest } from '@jest/globals';

// Must be set before util/cors.js is imported: it reads NODE_ENV once, at
// module scope, to decide whether to allow all origins.
process.env.NODE_ENV = 'production';

jest.unstable_mockModule('../../util/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const express = (await import('express')).default;
const cors = (await import('cors')).default;
const request = (await import('supertest')).default;
const Logger = (await import('../../util/logger.js')).default;
const corsOptions = (await import('../../util/cors.js')).default;
const { errorHandler } = await import('../../middleware/errorMiddleware.js');

// Mounted exactly as app.js does: cors(corsOptions) up front, errorHandler last.
const buildApp = () => {
  const app = express();
  app.use(cors(corsOptions));
  app.get('/ping', (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
};

describe('CORS blocked origin response', () => {
  const BAD_ORIGIN = 'https://evil.example';

  it('returns 403 CORS_BLOCKED, not 500, for a disallowed origin', async () => {
    const res = await request(buildApp()).get('/ping').set('Origin', BAD_ORIGIN);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('CORS_BLOCKED');
    expect(typeof res.body.message).toBe('string');
  });

  it('does not echo the blocked origin or a stack trace to the client', async () => {
    const res = await request(buildApp()).get('/ping').set('Origin', BAD_ORIGIN);

    expect(JSON.stringify(res.body)).not.toContain(BAD_ORIGIN);
    expect(res.body.stack).toBeFalsy();
  });

  it('blocks the preflight too, with the same shape', async () => {
    const res = await request(buildApp())
      .options('/ping')
      .set('Origin', BAD_ORIGIN)
      .set('Access-Control-Request-Method', 'GET');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CORS_BLOCKED');
  });

  it('logs the origin server-side only', async () => {
    await request(buildApp()).get('/ping').set('Origin', BAD_ORIGIN);
    expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining(BAD_ORIGIN));
  });

  it('still allows an allowlisted origin (allowlist unchanged)', async () => {
    const res = await request(buildApp())
      .get('/ping')
      .set('Origin', 'https://keplix.co.in');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://keplix.co.in');
  });

  it('still allows origin-less (server-to-server / mobile) requests', async () => {
    const res = await request(buildApp()).get('/ping');
    expect(res.status).toBe(200);
  });
});
