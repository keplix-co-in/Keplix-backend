/**
 * Load / stress profile for the Keplix API.
 *
 *   k6 run tests/load/smoke-and-stress.js                    # smoke, default target
 *   k6 run -e PROFILE=load    -e BASE_URL=https://staging... tests/load/smoke-and-stress.js
 *   k6 run -e PROFILE=stress  -e BASE_URL=https://staging... tests/load/smoke-and-stress.js
 *   k6 run -e PROFILE=soak    -e BASE_URL=https://staging... tests/load/smoke-and-stress.js
 *
 * Install k6: https://k6.io/docs/get-started/installation/
 *
 * ----------------------------------------------------------------------------
 * READ THIS BEFORE RUNNING
 * ----------------------------------------------------------------------------
 * 1. NEVER point this at production. It will trip the global rate limiter
 *    (1000 req / 15 min per IP) and lock out real users, it bills real Cloud Run
 *    instance time, and any authenticated scenario writes real rows.
 *
 * 2. The rate limiter makes results meaningless unless you raise it on the
 *    target. In app.js the global limiter is `max: 1000` over 15 minutes --
 *    roughly 1.1 req/sec. Above that everything is a 429 and you are measuring
 *    express-rate-limit, not the application. Raise it on staging, or the graphs
 *    are worthless.
 *
 * 3. Run against a SEPARATE database. Not a copy pointed at the same pooler --
 *    connection exhaustion is one of the things being tested for, and you do not
 *    want to starve production of connections while finding that out.
 *
 * 4. Warm the service first (see setup below). With --min-instances 0 the first
 *    request pays a ~5s cold start, which otherwise poisons your p95.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const PROFILE = __ENV.PROFILE || 'smoke';

// Custom metrics. The built-in http_req_duration mixes every endpoint together,
// which hides the one slow route behind a hundred fast ones.
const healthLatency = new Trend('latency_health');
const blogLatency = new Trend('latency_blog_list');
const authLatency = new Trend('latency_auth_reject');
const rateLimited = new Counter('responses_429');
const serverErrors = new Counter('responses_5xx');
const okRate = new Rate('non_error_responses');

/**
 * Four profiles, because "stress test" covers several different questions.
 *
 *  smoke  -- does it work at all under trivial load? Run this first, always.
 *  load   -- does it hold up at expected peak? This is your capacity answer.
 *  stress -- where does it break, and does it fail gracefully or fall over?
 *  soak   -- does it degrade over time? Finds leaks and connection exhaustion,
 *            which a short burst will not.
 */
const profiles = {
  smoke: {
    stages: [
      { duration: '30s', target: 5 },
      { duration: '30s', target: 5 },
      { duration: '10s', target: 0 },
    ],
  },
  load: {
    stages: [
      { duration: '1m', target: 25 },
      { duration: '3m', target: 25 },
      { duration: '1m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0 },
    ],
  },
  // Ramps past the expected breaking point on purpose. The number you want out
  // of this is not "it survived" but "it started failing at N VUs, and it
  // returned 503s rather than hanging".
  stress: {
    stages: [
      { duration: '1m', target: 50 },
      { duration: '2m', target: 100 },
      { duration: '2m', target: 200 },
      { duration: '2m', target: 400 },
      { duration: '2m', target: 0 },
    ],
  },
  // Long and flat. Connection-pool exhaustion and memory leaks show up here and
  // nowhere else -- a 2-minute burst will pass while a 30-minute hold fails.
  soak: {
    stages: [
      { duration: '2m', target: 30 },
      { duration: '30m', target: 30 },
      { duration: '2m', target: 0 },
    ],
  },
};

export const options = {
  stages: profiles[PROFILE].stages,
  thresholds: {
    // Deliberately expressed as pass/fail rather than "watch the graph". A load
    // test with no thresholds is a screensaver.
    http_req_failed: ['rate<0.01'],
    latency_health: ['p(95)<500'],
    latency_blog_list: ['p(95)<1500'],
    responses_5xx: ['count<10'],
  },
  // Cloud Run terminates idle connections; without this k6 reuses sockets in a
  // way that under-reports connection setup cost.
  noConnectionReuse: false,
  userAgent: 'k6-keplix-loadtest',
};

export function setup() {
  // Warm the service so the first VU does not absorb a cold start and skew p95.
  // With --min-instances 0 this is worth ~5 seconds on the first request.
  const warm = http.get(`${BASE_URL}/health`, { timeout: '60s' });
  if (warm.status !== 200) {
    throw new Error(
      `Target is not healthy before the test started: HTTP ${warm.status} from ${BASE_URL}/health. ` +
        `Check BASE_URL and that the service is deployed.`,
    );
  }
  const body = warm.json();
  console.log(`Target up. env=${body.environment} db=${body.checks && body.checks.database}`);

  if (body.environment === 'production') {
    throw new Error(
      'Refusing to run: target reports environment="production". Point this at staging. ' +
        'See the header comment in this file for why.',
    );
  }
  return { startedAt: Date.now() };
}

function record(res, trend) {
  trend.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  if (res.status >= 500) serverErrors.add(1);
  okRate.add(res.status < 500);
}

export default function () {
  // Read-only endpoints only. Nothing here creates a booking, a payment or a
  // user -- adding write scenarios means adding cleanup, and a load test that
  // leaves 40,000 orphan bookings behind is its own problem.
  group('health', () => {
    const res = http.get(`${BASE_URL}/health`);
    record(res, healthLatency);
    check(res, {
      'health 200': (r) => r.status === 200,
      'db reported ok': (r) => r.json('checks.database') === 'ok',
    });
  });

  group('public content', () => {
    const res = http.get(`${BASE_URL}/content/blog/posts`);
    record(res, blogLatency);
    check(res, {
      'blog 200': (r) => r.status === 200,
      'blog returns array': (r) => Array.isArray(r.json('data')),
    });
  });

  group('auth rejection path', () => {
    // Exercises the auth middleware and JWT verification without creating
    // anything. Also confirms the service still REJECTS correctly under load --
    // a system that starts letting unauthenticated requests through when
    // saturated is worse than one that returns 503.
    const res = http.get(`${BASE_URL}/accounts/vendor/profile`);
    record(res, authLatency);
    check(res, {
      'protected route still 401 under load': (r) => r.status === 401,
      'never 200 without a token': (r) => r.status !== 200,
    });
  });

  sleep(1);
}

export function teardown(data) {
  const mins = ((Date.now() - data.startedAt) / 60000).toFixed(1);
  console.log(`Finished after ${mins} min. Check responses_429 -- if it is non-zero you measured the rate limiter, not the app.`);
}
