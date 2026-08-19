import { jest } from '@jest/globals';

// All database calls are mocked — no real DB connection is made
jest.unstable_mockModule('../../../util/prisma.js', () => ({
  default: {
    $queryRaw: jest.fn(),
    service: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
    },
    // getAllServices/getServiceById now enrich with segment pricing; default
    // to "none found" so every existing test — none of which sets up segment
    // prices — keeps its prior behaviour (segment_prices: []) unmodified.
    serviceSegmentPrice: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

const { getAllServices, getServiceById, getServiceCategories, getFeaturedServices, searchVendorsByLocation, getServicesByVendor } = await import('../../../controllers/user/serviceController.js');
const prisma = (await import('../../../util/prisma.js')).default;

function mockReq(overrides = {}) {
  return {
    query: {},
    params: {},
    protocol: 'https',
    get: jest.fn().mockReturnValue('example.com'),
    ...overrides,
  };
}

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── getAllServices ──────────────────────────────────────────────────

describe('getAllServices', () => {
  describe('without location (Prisma path)', () => {
    it('returns services with default pagination', async () => {
      const services = [
        {
          id: 1, name: 'Haircut', description: 'A haircut', price: 100, duration: 30,
          category: 'Beauty', image_url: '/img/hair.png', is_active: true, is_featured: false,
          vendorId: 10,
          vendor: { vendorProfile: { business_name: 'Salon A', image: '/v.png', cover_image: '/c.png', address: '123 St', city: 'NYC' } },
        },
      ];
      prisma.service.findMany.mockResolvedValue(services);
      prisma.service.count.mockResolvedValue(1);

      const req = mockReq();
      const res = mockRes();
      await getAllServices(req, res);

      expect(prisma.service.findMany).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 1, name: 'Haircut', vendor_name: 'Salon A', distance: null, distanceText: null }),
        ])
      );
    });

    it('applies search filter', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      const req = mockReq({ query: { search: 'plumbing' } });
      const res = mockRes();
      await getAllServices(req, res);

      const whereArg = prisma.service.findMany.mock.calls[0][0].where;
      expect(whereArg.OR).toBeDefined();
      expect(whereArg.OR[0]).toEqual({ name: { contains: 'plumbing', mode: 'insensitive' } });
    });

    it('applies online_only filter', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      const req = mockReq({ query: { online_only: 'true' } });
      const res = mockRes();
      await getAllServices(req, res);

      const whereArg = prisma.service.findMany.mock.calls[0][0].where;
      expect(whereArg.vendor).toEqual({ vendorProfile: { is_online: true } });
    });

    it('ignores online_only when not "true"', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      const req = mockReq({ query: { online_only: 'false' } });
      const res = mockRes();
      await getAllServices(req, res);

      const whereArg = prisma.service.findMany.mock.calls[0][0].where;
      expect(whereArg.vendor).toBeUndefined();
    });

    it('respects page and limit', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      const req = mockReq({ query: { page: '3', limit: '5' } });
      const res = mockRes();
      await getAllServices(req, res);

      const args = prisma.service.findMany.mock.calls[0][0];
      expect(args.skip).toBe(10);
      expect(args.take).toBe(5);
    });

    it('builds full image URL for relative paths', async () => {
      prisma.service.findMany.mockResolvedValue([
        { id: 1, name: 'S', image_url: '/uploads/img.png', vendor: { vendorProfile: {} } },
      ]);
      prisma.service.count.mockResolvedValue(1);

      const req = mockReq();
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.json.mock.calls[0][0][0].image_url).toBe('https://example.com/uploads/img.png');
    });

    it('passes through absolute image URLs unchanged', async () => {
      prisma.service.findMany.mockResolvedValue([
        { id: 1, name: 'S', image_url: 'https://cdn.example.com/img.png', vendor: { vendorProfile: {} } },
      ]);
      prisma.service.count.mockResolvedValue(1);

      const req = mockReq();
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.json.mock.calls[0][0][0].image_url).toBe('https://cdn.example.com/img.png');
    });

    it('returns null image_url when not set', async () => {
      prisma.service.findMany.mockResolvedValue([
        { id: 1, name: 'S', image_url: null, vendor: { vendorProfile: {} } },
      ]);
      prisma.service.count.mockResolvedValue(1);

      const req = mockReq();
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.json.mock.calls[0][0][0].image_url).toBeNull();
    });

    it('falls back to "Vendor" when vendorProfile is missing', async () => {
      prisma.service.findMany.mockResolvedValue([
        { id: 1, name: 'S', image_url: null, vendor: { vendorProfile: null } },
      ]);
      prisma.service.count.mockResolvedValue(1);

      const req = mockReq();
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.json.mock.calls[0][0][0].vendor_name).toBe('Vendor');
    });
  });

  describe('with location (raw SQL path)', () => {
    it('uses raw SQL and returns distance info', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 1, name: 'Nearby', image_url: null, vendorId: 10, vendor_name: 'V1', vendor_image: null, cover_image: null, vendor_address: 'Addr', vendor_city: 'City', distance: 2.5, is_active: true, is_featured: false, price: 50, duration: 30, category: 'Clean', description: 'Desc' },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([{ total: 1 }]);

      const req = mockReq({ query: { latitude: '28.6', longitude: '77.2' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const result = res.json.mock.calls[0][0];
      expect(result[0].distance).toBe(2.5);
      expect(result[0].distanceText).toBe('2.5km away');
    });

    it('formats distance < 1km in meters', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 1, name: 'S', image_url: null, vendorId: 10, vendor_name: 'V', vendor_image: null, cover_image: null, vendor_address: null, vendor_city: null, distance: 0.35, is_active: true, is_featured: false, price: 50, duration: 30, category: 'C', description: 'D' },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([{ total: 1 }]);

      const req = mockReq({ query: { latitude: '28.6', longitude: '77.2' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.json.mock.calls[0][0][0].distanceText).toBe('350m away');
    });

    it('uses custom radius', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      prisma.$queryRaw.mockResolvedValueOnce([{ total: 0 }]);

      const req = mockReq({ query: { latitude: '28.6', longitude: '77.2', radius: '100' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('returns empty when count result is empty', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      prisma.$queryRaw.mockResolvedValueOnce([{}]);

      const req = mockReq({ query: { latitude: '28.6', longitude: '77.2' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.json.mock.calls[0][0]).toEqual([]);
    });

    it('falls back to Prisma path when only latitude is provided', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      const req = mockReq({ query: { latitude: '28.6' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.service.findMany).toHaveBeenCalled();
    });

    it('falls back to Prisma path when only longitude is provided', async () => {
      prisma.service.findMany.mockResolvedValue([]);
      prisma.service.count.mockResolvedValue(0);

      const req = mockReq({ query: { longitude: '77.2' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.service.findMany).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('returns 500 on database error (Prisma path)', async () => {
      prisma.service.findMany.mockRejectedValue(new Error('DB down'));

      const req = mockReq();
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Server Error' });
    });

    it('returns 500 on database error (raw SQL path)', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('DB down'));

      const req = mockReq({ query: { latitude: '28.6', longitude: '77.2' } });
      const res = mockRes();
      await getAllServices(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

// ─── getServiceById ─────────────────────────────────────────────────

describe('getServiceById', () => {
  it('returns enriched service when found', async () => {
    prisma.service.findUnique.mockResolvedValue({
      id: 1, name: 'S', image_url: '/img.png',
      vendor: { vendorProfile: { business_name: 'Biz', image: '/v.png', cover_image: '/c.png' } },
    });

    const req = mockReq({ params: { id: '1' } });
    const res = mockRes();
    await getServiceById(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      id: 1, vendor_name: 'Biz', image_url: 'https://example.com/img.png',
    }));
  });

  it('returns 404 when service not found', async () => {
    prisma.service.findUnique.mockResolvedValue(null);

    const req = mockReq({ params: { id: '999' } });
    const res = mockRes();
    await getServiceById(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: 'Service not found' });
  });

  it('handles missing vendorProfile gracefully', async () => {
    prisma.service.findUnique.mockResolvedValue({
      id: 1, name: 'S', image_url: null,
      vendor: { vendorProfile: null },
    });

    const req = mockReq({ params: { id: '1' } });
    const res = mockRes();
    await getServiceById(req, res);

    expect(res.json.mock.calls[0][0].vendor_name).toBe('Vendor');
    expect(res.json.mock.calls[0][0].vendor_image).toBeNull();
  });

  it('returns 500 on error', async () => {
    prisma.service.findUnique.mockRejectedValue(new Error('fail'));

    const req = mockReq({ params: { id: '1' } });
    const res = mockRes();
    await getServiceById(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─── getServiceCategories ───────────────────────────────────────────

describe('getServiceCategories', () => {
  it('returns formatted categories', async () => {
    prisma.service.groupBy.mockResolvedValue([{ category: 'Beauty' }, { category: 'Cleaning' }]);

    const req = mockReq();
    const res = mockRes();
    await getServiceCategories(req, res);

    expect(res.json).toHaveBeenCalledWith([{ name: 'Beauty' }, { name: 'Cleaning' }]);
  });

  it('returns empty array when no categories', async () => {
    prisma.service.groupBy.mockResolvedValue([]);

    const req = mockReq();
    const res = mockRes();
    await getServiceCategories(req, res);

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('returns 500 on error', async () => {
    prisma.service.groupBy.mockRejectedValue(new Error('fail'));

    const req = mockReq();
    const res = mockRes();
    await getServiceCategories(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─── getFeaturedServices ────────────────────────────────────────────

describe('getFeaturedServices', () => {
  it('returns featured services with pagination metadata', async () => {
    const services = [
      { id: 1, name: 'Featured', image_url: null, vendor: { vendorProfile: { business_name: 'V', image: null, cover_image: null } } },
    ];
    prisma.service.findMany.mockResolvedValue(services);
    prisma.service.count.mockResolvedValue(1);

    const req = mockReq();
    const res = mockRes();
    await getFeaturedServices(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });
  });

  it('respects custom page and limit', async () => {
    prisma.service.findMany.mockResolvedValue([]);
    prisma.service.count.mockResolvedValue(0);

    const req = mockReq({ query: { page: '2', limit: '5' } });
    const res = mockRes();
    await getFeaturedServices(req, res);

    const args = prisma.service.findMany.mock.calls[0][0];
    expect(args.skip).toBe(5);
    expect(args.take).toBe(5);
  });

  it('returns 500 on error', async () => {
    prisma.service.findMany.mockRejectedValue(new Error('fail'));

    const req = mockReq();
    const res = mockRes();
    await getFeaturedServices(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─── searchVendorsByLocation ────────────────────────────────────────

describe('searchVendorsByLocation', () => {
  it('returns 400 when latitude is missing', async () => {
    const req = mockReq({ query: { longitude: '77.2' } });
    const res = mockRes();
    await searchVendorsByLocation(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or missing latitude/longitude' });
  });

  it('returns 400 when longitude is missing', async () => {
    const req = mockReq({ query: { latitude: '28.6' } });
    const res = mockRes();
    await searchVendorsByLocation(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when both are missing', async () => {
    const req = mockReq();
    const res = mockRes();
    await searchVendorsByLocation(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns nearby vendors and their services', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { userId: 10, business_name: 'V1', address: 'A', latitude: 28.6, longitude: 77.2, distance: 3.5 },
    ]);
    prisma.service.findMany.mockResolvedValue([
      { id: 1, name: 'S1', vendorId: 10, is_active: true },
    ]);

    const req = mockReq({ query: { latitude: '28.6', longitude: '77.2', radius: '10' } });
    const res = mockRes();
    await searchVendorsByLocation(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.vendors).toHaveLength(1);
    expect(body.vendors[0].distance).toBe(3.5);
    expect(body.services).toHaveLength(1);
  });

  it('returns empty when no vendors nearby', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.service.findMany.mockResolvedValue([]);

    const req = mockReq({ query: { latitude: '28.6', longitude: '77.2' } });
    const res = mockRes();
    await searchVendorsByLocation(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.vendors).toEqual([]);
    expect(body.services).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('DB fail'));

    const req = mockReq({ query: { latitude: '28.6', longitude: '77.2' } });
    const res = mockRes();
    await searchVendorsByLocation(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─── getServicesByVendor ────────────────────────────────────────────

describe('getServicesByVendor', () => {
  it('returns enriched services for a vendor', async () => {
    prisma.service.findMany.mockResolvedValue([
      { id: 1, name: 'S', image_url: '/img.png', vendorId: 5, vendor: { vendorProfile: { business_name: 'Biz', image: '/v.png', cover_image: '/c.png' } } },
    ]);

    const req = mockReq({ params: { vendorId: '5' } });
    const res = mockRes();
    await getServicesByVendor(req, res);

    const result = res.json.mock.calls[0][0];
    expect(result).toHaveLength(1);
    expect(result[0].vendor_name).toBe('Biz');
    expect(result[0].image_url).toBe('https://example.com/img.png');
  });

  it('returns empty array when vendor has no services', async () => {
    prisma.service.findMany.mockResolvedValue([]);

    const req = mockReq({ params: { vendorId: '5' } });
    const res = mockRes();
    await getServicesByVendor(req, res);

    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('returns 500 on error', async () => {
    prisma.service.findMany.mockRejectedValue(new Error('fail'));

    const req = mockReq({ params: { vendorId: '5' } });
    const res = mockRes();
    await getServicesByVendor(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
