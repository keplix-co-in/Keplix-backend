/**
 * Regression test for the vendor feedback route mismatch, found by the
 * 2026-09-28 Interactions module audit.
 *
 * routes/vendor/feedback.js is mounted at /interactions/api/vendor (app.js),
 * alongside the vendor reviews/interactions/notifications routers. Its GET
 * and POST handlers were registered at `/` and `/create` with no `/feedback`
 * prefix, so:
 *   - GET  '/' resolved to `/interactions/api/vendor` itself, a path shared
 *     with the sibling routers (the same class of bug already fixed in
 *     routes/vendor/reviews.js, see its file comment).
 *   - POST '/create' resolved to `/interactions/api/vendor/create`, not the
 *     documented and only guessable `/interactions/api/vendor/feedback/create`
 *     (mirroring the customer-side `/interactions/api/feedback/create`).
 *
 * Separately, createVendorFeedback needs {title, message, category} (the
 * Feedback model's required columns -- identical to the customer-side
 * controller it was copied from), but the route had no validator and its own
 * swagger doc promised {comment, rating}, which the controller never reads.
 * Posting that documented shape threw an unhandled Prisma error (500) instead
 * of a clean 400.
 *
 * Fix: routes now explicitly prefix `/feedback`, and the create route uses
 * the same createFeedbackSchema validator as the customer-side route.
 *
 * See tests/regressions/corsBlockedResponse.test.js for the file convention.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../util/prisma.js', () => ({
  default: {
    feedback: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

// Route file imports `protect` directly and wires it in as middleware, so it
// must be mocked before the route module is imported -- attaching req.user
// via a preceding app.use() is not enough, the real middleware would still
// run and reject the unauthenticated request with 401.
jest.unstable_mockModule('../../middleware/authMiddleware.js', () => ({
  protect: (req, res, next) => { req.user = { id: 501 }; next(); },
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const prisma = (await import('../../util/prisma.js')).default;
const vendorFeedbackRoutes = (await import('../../routes/vendor/feedback.js')).default;

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/interactions/api/vendor', vendorFeedbackRoutes);
  app.use((err, req, res, next) => res.status(500).json({ message: 'Server Error' }));
  return app;
};

describe('vendor feedback route path (regression)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /interactions/api/vendor/feedback/create reaches the handler', async () => {
    prisma.feedback.create.mockResolvedValue({ id: 1, userId: 501, title: 't', message: 'm', category: 'general' });

    const res = await request(buildApp())
      .post('/interactions/api/vendor/feedback/create')
      .send({ title: 't', message: 'm', category: 'general' });

    expect(res.status).toBe(201);
    expect(prisma.feedback.create).toHaveBeenCalled();
  });

  it('does NOT resolve at the old unprefixed /interactions/api/vendor/create path', async () => {
    const res = await request(buildApp())
      .post('/interactions/api/vendor/create')
      .send({ title: 't', message: 'm', category: 'general' });

    expect(res.status).toBe(404);
  });

  it('rejects a request missing required fields with 400, not an unhandled 500', async () => {
    const res = await request(buildApp())
      .post('/interactions/api/vendor/feedback/create')
      .send({ comment: 'Please add payouts dashboard' }); // the old (wrong) documented shape

    expect(res.status).toBe(400);
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it('GET /interactions/api/vendor/feedback still lists feedback', async () => {
    prisma.feedback.findMany.mockResolvedValue([]);

    const res = await request(buildApp()).get('/interactions/api/vendor/feedback');

    expect(res.status).toBe(200);
  });
});
