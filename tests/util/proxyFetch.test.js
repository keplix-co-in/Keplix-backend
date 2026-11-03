// Tests for util/proxyFetch.js against a local fake CONNECT proxy and a local
// HTTPS server (self-signed cert in tests/fixtures/tls). Nothing leaves this
// machine.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProxyFetch } from '../../util/proxyFetch.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cert = fs.readFileSync(path.join(dir, '../fixtures/tls/localhost-cert.pem'));
const key = fs.readFileSync(path.join(dir, '../fixtures/tls/localhost-key.pem'));

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });

let target;
let targetPort;
let proxy;
let proxyPort;
let lastRequest;
let connects;
let sockets;

beforeAll(async () => {
  // Fake RazorpayX: echoes what it received.
  target = https.createServer({ key, cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastRequest = { method: req.method, url: req.url, headers: req.headers, body };
      if (req.url.startsWith('/hang')) return; // never answers
      if (req.url.startsWith('/drop')) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"partial":');
        setTimeout(() => res.socket.destroy(), 20); // dies mid-response
        return;
      }
      const status = req.url.startsWith('/fail') ? 400 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ echoed: body ? JSON.parse(body) : null, path: req.url }));
    });
  });
  targetPort = await listen(target);

  // Fake tinyproxy: Basic auth "keplix:s3cret", tunnels only to the target.
  sockets = new Set();
  proxy = http.createServer((req, res) => res.writeHead(405).end());
  proxy.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  proxy.on('connect', (req, clientSocket, head) => {
    connects.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    const expected = 'Basic ' + Buffer.from('keplix:s3cret').toString('base64');
    if (req.headers['proxy-authorization'] !== expected) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    if (req.url !== `localhost:${targetPort}`) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  proxyPort = await listen(proxy);
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await Promise.all([close(proxy), close(target)]);
});

beforeEach(() => {
  connects = [];
  lastRequest = null;
});

const goodProxy = () => `http://keplix:s3cret@127.0.0.1:${proxyPort}`;
const tlsOptions = { ca: cert };

describe('createProxyFetch', () => {
  it('sends a POST through the tunnel with headers and body intact', async () => {
    const fetchImpl = createProxyFetch(goodProxy(), { tlsOptions });
    const res = await fetchImpl(`https://localhost:${targetPort}/v1/payouts?x=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payout-Idempotency': 'payout_payment_7' },
      body: JSON.stringify({ amount: 100 }),
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ echoed: { amount: 100 }, path: '/v1/payouts?x=1' });
    expect(lastRequest.method).toBe('POST');
    expect(lastRequest.headers['x-payout-idempotency']).toBe('payout_payment_7');
    expect(connects).toEqual([
      { url: `localhost:${targetPort}`, auth: 'Basic ' + Buffer.from('keplix:s3cret').toString('base64') },
    ]);
  });

  it('sends a GET with no body', async () => {
    const fetchImpl = createProxyFetch(goodProxy(), { tlsOptions });
    const res = await fetchImpl(`https://localhost:${targetPort}/v1/payouts/pout_1`, { method: 'GET', headers: {} });
    expect(res.status).toBe(200);
    expect(lastRequest.method).toBe('GET');
    expect(lastRequest.body).toBe('');
  });

  it('passes a non-2xx gateway response through as ok=false', async () => {
    const fetchImpl = createProxyFetch(goodProxy(), { tlsOptions });
    const res = await fetchImpl(`https://localhost:${targetPort}/fail`, { method: 'GET' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  it('decodes URL-encoded proxy credentials', async () => {
    const fetchImpl = createProxyFetch(`http://kep%6Cix:s3cr%65t@127.0.0.1:${proxyPort}`, { tlsOptions });
    const res = await fetchImpl(`https://localhost:${targetPort}/ok`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('rejects with a clear error on a wrong proxy password (407)', async () => {
    const fetchImpl = createProxyFetch(`http://keplix:wrong@127.0.0.1:${proxyPort}`, { tlsOptions });
    await expect(fetchImpl(`https://localhost:${targetPort}/ok`)).rejects.toThrow(
      'Payout proxy refused the tunnel (HTTP 407)'
    );
    expect(lastRequest).toBeNull();
  });

  it('rejects when the proxy refuses the host (403)', async () => {
    const fetchImpl = createProxyFetch(goodProxy(), { tlsOptions });
    await expect(fetchImpl(`https://127.0.0.1:${targetPort}/ok`)).rejects.toThrow('HTTP 403');
  });

  it('rejects when the proxy is unreachable', async () => {
    const dead = net.createServer();
    const deadPort = await listen(dead);
    await close(dead);
    const fetchImpl = createProxyFetch(`http://keplix:s3cret@127.0.0.1:${deadPort}`, { tlsOptions });
    await expect(fetchImpl(`https://localhost:${targetPort}/ok`)).rejects.toThrow('Payout proxy unreachable');
  });

  it('refuses a TLS certificate it does not trust', async () => {
    // No CA passed: the self-signed target must be rejected, proving TLS is
    // really verified end-to-end through the tunnel.
    const fetchImpl = createProxyFetch(goodProxy());
    await expect(fetchImpl(`https://localhost:${targetPort}/ok`)).rejects.toThrow();
    expect(lastRequest).toBeNull();
  });

  it('rejects a non-http proxy URL and a non-https target', async () => {
    expect(() => createProxyFetch('https://127.0.0.1:1')).toThrow('must start with http://');
    const fetchImpl = createProxyFetch(goodProxy(), { tlsOptions });
    await expect(fetchImpl('http://localhost/x')).rejects.toThrow('only sends https://');
  });

  it('times out a proxy that never answers', async () => {
    const silent = net.createServer(() => {});
    const held = new Set();
    silent.on('connection', (s) => held.add(s));
    const silentPort = await listen(silent);
    const fetchImpl = createProxyFetch(`http://keplix:s3cret@127.0.0.1:${silentPort}`, { timeoutMs: 200, tlsOptions });
    await expect(fetchImpl(`https://localhost:${targetPort}/ok`)).rejects.toThrow('timed out');
    for (const s of held) s.destroy();
    await close(silent);
  });

  it('times out a TLS handshake that stalls after the tunnel opens', async () => {
    // Proxy says 200 then relays nothing: the case where the path to Razorpay
    // silently drops packets. Must reject, not hang the payout worker.
    const held = new Set();
    const blackhole = http.createServer();
    blackhole.on('connect', (req, s) => {
      held.add(s);
      s.write('HTTP/1.1 200 Connection established\r\n\r\n');
    });
    const port = await listen(blackhole);
    const fetchImpl = createProxyFetch(`http://keplix:s3cret@127.0.0.1:${port}`, { timeoutMs: 200, tlsOptions });
    await expect(fetchImpl(`https://localhost:${targetPort}/ok`)).rejects.toThrow('TLS handshake timed out');
    for (const s of held) s.destroy();
    await close(blackhole);
  });

  it('times out a request the gateway never answers', async () => {
    const fetchImpl = createProxyFetch(goodProxy(), { timeoutMs: 300, tlsOptions });
    await expect(fetchImpl(`https://localhost:${targetPort}/hang`, { method: 'GET' })).rejects.toThrow(
      'RazorpayX request timed out'
    );
  });

  it('rejects when the gateway drops the connection mid-response', async () => {
    const fetchImpl = createProxyFetch(goodProxy(), { tlsOptions });
    await expect(fetchImpl(`https://localhost:${targetPort}/drop`, { method: 'GET' })).rejects.toThrow();
  });

  it('rejects malformed proxy URLs without echoing the password', () => {
    const bad = [
      'not a url s3cretpw',
      'http://127.0.0.1:8888', // no credentials
      'http://keplix:s3cretpw@127.0.0.1', // no port
      'http://keplix:ab#s3cretpw@127.0.0.1:8888', // unencoded # in password
    ];
    for (const url of bad) {
      let message;
      try {
        createProxyFetch(url);
      } catch (err) {
        message = err.message;
      }
      expect(message).toMatch(/RAZORPAYX_PROXY_URL/);
      expect(message).not.toMatch(/s3cretpw/);
    }
  });
});

describe('createProxyFetch with the real RazorpayX client', () => {
  it('surfaces a dead proxy as a plain Error the payout worker can retry', async () => {
    const { createRazorpayXClient } = await import('../../util/razorpayXClient.js');
    const dead = net.createServer();
    const deadPort = await listen(dead);
    await close(dead);
    const client = createRazorpayXClient({
      keyId: 'rzp_test_x',
      keySecret: 'y',
      fetchImpl: createProxyFetch(`http://keplix:s3cretpw@127.0.0.1:${deadPort}`),
    });
    const err = await client.createPayout({ amount: 100 }, 'payout_payment_1').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Payout proxy unreachable/);
    expect(err.message).not.toMatch(/s3cretpw/);
  });
});
