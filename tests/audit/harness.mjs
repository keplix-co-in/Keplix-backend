// End-to-end audit harness: boots the REAL Express app in-process against a
// throwaway Postgres database (never production) and exposes helpers for
// calling routes and enumerating them.
//
// Point AUDIT_DB_NAME at a database name unique to your module (e.g.
// "keplix_audit_payments") before importing this file, so parallel audit runs
// never share state:
//
//   process.env.AUDIT_DB_NAME = 'keplix_audit_<module>';
//   const { seed, call, token, ... } = await import('./harness.mjs');
//
// The database itself must already exist (see AUDIT.md) — `prisma db push`
// creates the tables the first time.
//
// No .env is loaded and every external-service credential is unset or fake,
// so nothing here can email, SMS, push, or charge anyone for real.
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import path from 'node:path';

export const BACKEND = path.resolve(import.meta.dirname, '..', '..');
const imp = (rel) => import(pathToFileURL(path.join(BACKEND, rel)).href);

const dbName = process.env.AUDIT_DB_NAME || 'keplix_audit';
const pgHost = process.env.AUDIT_PG_URL || `postgresql://postgres@localhost:55432/${dbName}`;

Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: pgHost,
  MIGRATION_DATABASE_URL: pgHost,
  JWT_SECRET: 'audit_access_secret_0123456789abcdef0123456789abcdef',
  JWT_REFRESH_SECRET: 'audit_refresh_secret_0123456789abcdef0123456789abcd',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  FRONTEND_URL: 'http://localhost:3000',
  GOOGLE_ALLOWED_AUDIENCES: 'audit.apps.googleusercontent.com',
  RUN_WORKERS: 'false',
  RAZORPAY_KEY_ID: 'rzp_test_audit', RAZORPAY_KEY_SECRET: 'audit_secret', RAZORPAY_WEBHOOK_SECRET: 'audit_wh',
  VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '',
  CLOUDINARY_URL: 'cloudinary://000000000000000:audit_fake_secret@audit-fake',
});
for (const k of ['RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'FIREBASE_SERVICE_ACCOUNT_BASE64', 'STRIPE_SECRET_KEY', 'REDIS_HOST']) delete process.env[k];

export const { default: prisma } = await imp('util/prisma.js');
export const bcrypt = (await import(pathToFileURL(path.join(BACKEND, 'node_modules/bcryptjs/index.js')).href)).default;
const jwt = (await import(pathToFileURL(path.join(BACKEND, 'node_modules/jsonwebtoken/index.js')).href)).default;
const { default: app } = await imp('app.js');
const { initSocket } = await imp('socket.js');

export { app };
export const server = http.createServer(app);
app.set('io', initSocket(server));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
export const base = `http://127.0.0.1:${server.address().port}`;

export const token = (id) => jwt.sign({ id, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' });
export const adminToken = (id) =>
  jwt.sign({ id, role: 'admin', type: 'admin_access' }, process.env.JWT_SECRET, { expiresIn: '1h' });

export async function call(method, url, { as, body, headers = {} } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (as) h.Authorization = `Bearer ${as}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const t = Date.now();
  let res, text;
  try {
    res = await fetch(base + url, { method, headers: h, body: payload });
    text = await res.text();
  } catch (e) { return { status: 0, ms: Date.now() - t, error: String(e.message), json: null }; }
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ms: Date.now() - t, json, text: text.slice(0, 300) };
}

/** Enumerate every route registered on the app (method + path with :param placeholders). */
export function listRoutes() {
  const out = [];
  const prefixOf = (layer) => {
    const src = layer.regexp?.source ?? '';
    if (src === '^\\/?(?=\\/|$)') return '';
    return src.replace('^', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, ':param');
  };
  const walk = (stack, prefix) => {
    for (const l of stack) {
      if (l.route) for (const m of Object.keys(l.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + l.route.path });
      else if (l.name === 'router' && l.handle?.stack) walk(l.handle.stack, prefix + prefixOf(l));
    }
  };
  walk(app._router.stack, '');
  const seen = new Set();
  return out.filter((r) => { const k = r.method + ' ' + r.path; if (seen.has(k)) return false; seen.add(k); return true; });
}

export async function shutdown() { server.close(); await prisma.$disconnect(); }
