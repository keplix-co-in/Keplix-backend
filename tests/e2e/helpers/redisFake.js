/**
 * A minimal in-memory stand-in for the ioredis client in util/redis.js.
 *
 * Why this exists: middleware/authMiddleware.js caches users and checks a
 * token blacklist in Redis, and `isTokenBlacklisted` fails CLOSED — if Redis
 * is unreachable every authenticated request 401s. Without a Redis the whole
 * E2E suite would fail at the first authenticated call for a reason that has
 * nothing to do with payments.
 *
 * Faking it here (rather than requiring a Docker Redis) keeps the suite
 * runnable on any machine and in CI. The trade-off is explicit: this proves
 * nothing about real Redis behaviour. Real-infrastructure verification is the
 * job of the manual runbook (docs/PAYMENT-TEST-RUNBOOK.md), which runs against
 * an actual Redis.
 *
 * Only the surface the app actually touches is implemented. Anything missing
 * throws loudly rather than silently returning undefined, so a new Redis call
 * in production code fails the suite instead of quietly changing behaviour.
 */
export class RedisFake {
  constructor() {
    this.store = new Map();
    this.expiries = new Map();
  }

  #alive(key) {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry <= Date.now()) {
      this.store.delete(key);
      this.expiries.delete(key);
      return false;
    }
    return this.store.has(key);
  }

  async get(key) {
    return this.#alive(key) ? this.store.get(key) : null;
  }

  async set(key, value, ...args) {
    this.store.set(key, String(value));
    // Support the `set(key, value, 'EX', seconds)` form used by the app.
    const exIndex = args.findIndex((a) => String(a).toUpperCase() === 'EX');
    if (exIndex !== -1 && args[exIndex + 1] !== undefined) {
      this.expiries.set(key, Date.now() + Number(args[exIndex + 1]) * 1000);
    } else {
      this.expiries.delete(key);
    }
    return 'OK';
  }

  async setex(key, seconds, value) {
    this.store.set(key, String(value));
    this.expiries.set(key, Date.now() + Number(seconds) * 1000);
    return 'OK';
  }

  async del(...keys) {
    let removed = 0;
    for (const key of keys.flat()) {
      if (this.store.delete(key)) removed += 1;
      this.expiries.delete(key);
    }
    return removed;
  }

  async exists(...keys) {
    return keys.flat().filter((key) => this.#alive(key)).length;
  }

  async expire(key, seconds) {
    if (!this.#alive(key)) return 0;
    this.expiries.set(key, Date.now() + Number(seconds) * 1000);
    return 1;
  }

  async ttl(key) {
    if (!this.#alive(key)) return -2;
    const expiry = this.expiries.get(key);
    if (expiry === undefined) return -1;
    return Math.max(0, Math.round((expiry - Date.now()) / 1000));
  }

  async keys(pattern) {
    // Only the trailing-wildcard form the app uses is supported.
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return [...this.store.keys()].filter(
      (key) => this.#alive(key) && (pattern.endsWith('*') ? key.startsWith(prefix) : key === pattern),
    );
  }

  async incr(key) {
    const next = Number(this.#alive(key) ? this.store.get(key) : 0) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async ping() {
    return 'PONG';
  }

  async quit() {
    return 'OK';
  }

  async flushall() {
    this.store.clear();
    this.expiries.clear();
    return 'OK';
  }

  // ioredis emits events; the app attaches error/connect handlers at import.
  on() { return this; }
  once() { return this; }
  off() { return this; }
  removeListener() { return this; }

  reset() {
    this.store.clear();
    this.expiries.clear();
  }
}

export const redisFake = new RedisFake();
export default redisFake;
