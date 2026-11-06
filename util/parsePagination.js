// Security A-026: list endpoints used `take: Number(req.query.limit)`, so
// ?limit=1000000 made one request read (and serialise) a whole table.
// Every list limit goes through here: an integer in [1, 100].
export const MAX_PAGE_SIZE = 100;

// `max` is only raised for lists scoped to the caller's OWN rows, where live
// clients request a full history in one call (see the vendor bookings list).
export const clampLimit = (value, fallback = 20, max = MAX_PAGE_SIZE) => {
  const n = parseInt(value, 10);
  return Math.min(max, Math.max(1, Number.isFinite(n) ? n : fallback));
};

export const parsePagination = (query = {}, { defaultLimit = 20 } = {}) => {
  const limit = clampLimit(query.limit, defaultLimit);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { page, limit, skip: (page - 1) * limit };
};

export default parsePagination;
