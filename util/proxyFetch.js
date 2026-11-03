// Minimal fetch-like function that sends HTTPS requests through an HTTP
// proxy with a CONNECT tunnel.
//
// WHY (2026-11-03): RazorpayX only accepts payout API calls from allowlisted
// IP addresses. Cloud Run has no fixed outbound IP, and the paid fix (Cloud
// NAT + static IP) was declined over its monthly cost. So keplix-backend sends
// ONLY its RazorpayX calls through a locked-down proxy (tinyproxy, port 8888)
// on the free Oracle n8n VM, whose IP is the one on the RazorpayX allowlist.
//
// CONNECT keeps TLS end-to-end: the proxy only relays encrypted bytes, so it
// never sees the API keys or the payout data. Built on node's http/https/tls
// instead of undici's ProxyAgent so no new dependency (and no lockfile
// change) is needed.
//
// Returns only what util/razorpayXClient.js reads: { ok, status, json() }.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {string} proxyUrl e.g. http://user:pass@130.210.37.123:8888
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.tlsOptions] extra tls.connect options (tests pass a CA)
 */
export function createProxyFetch(proxyUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, tlsOptions = {} } = {}) {
  let proxy;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    // Don't echo the URL: it contains the proxy password.
    throw new Error('RAZORPAYX_PROXY_URL is not a valid URL (URL-encode special characters in the password)');
  }
  if (proxy.protocol !== 'http:') {
    throw new Error('RAZORPAYX_PROXY_URL must start with http://');
  }
  // A password with an unencoded #, /, ? or @ can still parse, but into the
  // wrong host or credentials. Requiring user, password and port catches most
  // of those at boot (config/env.js) instead of at the first vendor payout.
  if (!proxy.username || !proxy.password || !proxy.port) {
    throw new Error(
      'RAZORPAYX_PROXY_URL must look like http://user:password@host:port (URL-encode special characters in the password)'
    );
  }
  const proxyAuth =
    'Basic ' +
    Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');

  // Opens a TLS socket to the target through the proxy.
  function openTunnel(target) {
    return new Promise((resolve, reject) => {
      const targetPort = target.port || 443;
      const headers = { Host: `${target.hostname}:${targetPort}`, 'Proxy-Authorization': proxyAuth };

      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: `${target.hostname}:${targetPort}`,
        headers,
        timeout: timeoutMs,
      });
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          // 407 = wrong proxy password; 403 = host not on the proxy's allowlist.
          reject(new Error(`Payout proxy refused the tunnel (HTTP ${res.statusCode})`));
          return;
        }
        // The tunnel is up: stop the CONNECT timer so it can't kill the
        // payout request mid-flight. That request carries its own timeout.
        socket.setTimeout(0);
        const secure = tls.connect({ socket, servername: target.hostname, ...tlsOptions });
        // tls.connect has no timeout of its own and the request timeout only
        // starts after this resolves. Without this timer a handshake that
        // stalls (path to Razorpay silently dropping packets) never settles,
        // and reconcileInFlightPayouts awaits it forever.
        const handshakeTimer = setTimeout(
          () => secure.destroy(new Error(`Payout proxy TLS handshake timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        secure.once('secureConnect', () => {
          clearTimeout(handshakeTimer);
          resolve(secure);
        });
        secure.once('error', (err) => {
          clearTimeout(handshakeTimer);
          reject(err);
        });
      });
      req.once('timeout', () => req.destroy(new Error(`Payout proxy timed out after ${timeoutMs}ms`)));
      req.once('error', (err) => reject(new Error(`Payout proxy unreachable: ${err.message}`)));
      req.end();
    });
  }

  return async function proxyFetch(url, { method = 'GET', headers = {}, body } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:') {
      throw new Error('proxyFetch only sends https:// requests');
    }
    const socket = await openTunnel(target);

    return new Promise((resolve, reject) => {
      // Explicit deadline instead of https.request's `timeout` option: that
      // option never fires on a socket handed in through createConnection
      // (caught by the '/hang' test), and an idle timer wouldn't bound a
      // response that trickles in anyway.
      const deadline = setTimeout(
        () => req.destroy(new Error(`RazorpayX request timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      const settle = (fn) => (value) => {
        clearTimeout(deadline);
        fn(value);
      };
      resolve = settle(resolve);
      reject = settle(reject);
      const req = https.request(
        {
          host: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method,
          // No `agent` on purpose: node only uses createConnection when no
          // agent is set. `agent: false` makes it build a fresh Agent that
          // dials the target DIRECTLY, skipping the tunnel (caught by
          // tests/util/proxyFetch.test.js). The 'Connection: close' header
          // makes the server close the one-shot tunnel when it's done.
          createConnection: () => socket,
          headers: {
            ...(body === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) }),
            Connection: 'close',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.once('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: async () => JSON.parse(text),
              text: async () => text,
            });
          });
          res.once('error', reject);
        }
      );
      req.once('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}
