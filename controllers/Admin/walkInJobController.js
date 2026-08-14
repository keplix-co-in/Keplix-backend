import prisma from '../../util/prisma.js';

// @desc    List walk-in jobs across all garages
// @route   GET /admin/walk-in-jobs
export const listWalkInJobsAdmin = async (req, res) => {
  const { status, vendorId, from, to, page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  try {
    const where = {
      ...(status ? { status } : {}),
      ...(vendorId ? { vendorId: Number(vendorId) } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      prisma.walkInJob.findMany({
        where,
        include: {
          vehicle: { select: { registration: true, make: true, model: true } },
          vendor: { select: { vendorProfile: { select: { business_name: true } } } },
          healthSheet: { select: { id: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      prisma.walkInJob.count({ where }),
    ]);

    return res.json({ data, page: Number(page), limit: Number(limit), total });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    One walk-in job with its full health sheet, admin view (no redaction)
// @route   GET /admin/walk-in-jobs/:id
export const getWalkInJobAdmin = async (req, res) => {
  try {
    const job = await prisma.walkInJob.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        vehicle: true,
        vendor: { select: { id: true, vendorProfile: { select: { business_name: true } } } },
        healthSheet: { include: { items: { include: { component: true } } } },
      },
    });
    if (!job) return res.status(404).json({ message: 'Walk-in job not found' });
    return res.json({ job });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};

// @desc    Per-garage walk-in adoption — how many jobs, how many with a
//          submitted health sheet, since decision-makers will want to know
//          this before turning the completion gate on.
// @route   GET /admin/walk-in-jobs/adoption
export const getWalkInAdoption = async (req, res) => {
  try {
    const rows = await prisma.walkInJob.groupBy({
      by: ['vendorId'],
      _count: { _all: true },
    });

    const vendorIds = rows.map((r) => r.vendorId);
    const [vendors, withSheetCounts] = await Promise.all([
      prisma.vendorProfile.findMany({
        where: { userId: { in: vendorIds } },
        select: { userId: true, business_name: true },
      }),
      prisma.healthSheet.groupBy({
        by: ['vendorId'],
        where: { vendorId: { in: vendorIds }, walkInJobId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const nameByVendor = new Map(vendors.map((v) => [v.userId, v.business_name]));
    const sheetsByVendor = new Map(withSheetCounts.map((r) => [r.vendorId, r._count._all]));

    const data = rows
      .map((r) => ({
        vendorId: r.vendorId,
        business_name: nameByVendor.get(r.vendorId) || 'Unknown',
        total_jobs: r._count._all,
        jobs_with_health_sheet: sheetsByVendor.get(r.vendorId) || 0,
      }))
      .sort((a, b) => b.total_jobs - a.total_jobs);

    return res.json({ data });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};
