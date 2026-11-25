// Base URL for links we hand to clients (bill links). PUBLIC_BASE_URL wins when
// set: building it from req.protocol/host trusts the Host header, which a caller
// can influence, so a pinned origin is safer. Falls back to the request-derived
// value (trust proxy is set in app.js) so unconfigured environments keep working.
export const publicBaseUrl = (req) => {
  const fixed = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return fixed || `${req.protocol}://${req.get('host')}`;
};
