/**
 * Vendor earnings & settlement (mockup G08), derived from Payment fields by
 * util/vendorEarnings.js. Read-only; scoped to the caller's own bookings.
 */
import prisma from '../../util/prisma.js';
import { parseIdParam } from '../../util/parseIdParam.js';
import { AUTO_CONFIRM_HOURS } from '../../util/bookingStatusManager.js';
import { deriveEarnings, summarizeEarnings } from '../../util/vendorEarnings.js';

const PAYMENT_SELECT = {
  amount: true,
  status: true,
  platformFee: true,
  vendorAmount: true,
  feeModel: true,
  vendorPayoutStatus: true,
  payoutHoldUntil: true,
};

const SUMMARY_ROW_CAP = 5000;

// GET /service_api/vendor/bookings/:id/earnings
export const getBookingEarnings = async (req, res) => {
  const bookingId = parseIdParam(req.params.id);
  if (!bookingId) return res.status(400).json({ success: false, message: 'Invalid booking id', code: 'VALIDATION_ERROR' });
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        service_completed_at: true,
        service: { select: { vendorId: true } },
        payment: { select: PAYMENT_SELECT },
        finalBills: { where: { status: { in: ['issued', 'paid'] } }, select: { total: true, status: true, number: true } },
      },
    });
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found', code: 'NOT_FOUND' });
    if (booking.service?.vendorId !== req.user.id) {
      return res.status(403).json({ success: false, message: 'This booking is not yours', code: 'FORBIDDEN' });
    }
    const bill = booking.finalBills?.[0] ?? null;
    return res.status(200).json({
      booking_id: booking.id,
      bill_number: bill?.number ?? null,
      bill_total: bill ? Number(bill.total.toString()) : null,
      ...deriveEarnings(booking, booking.payment, { autoConfirmHours: AUTO_CONFIRM_HOURS }),
    });
  } catch (err) {
    console.error('[earnings] booking earnings failed:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', code: 'INTERNAL_SERVER_ERROR' });
  }
};

// GET /service_api/vendor/earnings/summary?from=ISO&to=ISO
export const getEarningsSummary = async (req, res) => {
  const parse = (v) => {
    if (v === undefined || v === '') return undefined;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = parse(req.query?.from);
  const to = parse(req.query?.to);
  if (from === null || to === null) {
    return res.status(400).json({ success: false, message: 'from/to must be ISO dates', code: 'VALIDATION_ERROR' });
  }
  try {
    const payments = await prisma.payment.findMany({
      where: {
        status: { in: ['success', 'refunded'] },
        booking: { service: { vendorId: req.user.id } },
        ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      },
      select: { ...PAYMENT_SELECT, booking: { select: { status: true, service_completed_at: true } } },
      orderBy: { createdAt: 'desc' },
      take: SUMMARY_ROW_CAP + 1,
    });
    // A cap, not a silent truncation: the app is told when the totals are partial.
    const truncated = payments.length > SUMMARY_ROW_CAP;
    const rows = payments.slice(0, SUMMARY_ROW_CAP).map((p) => deriveEarnings(p.booking, p, { autoConfirmHours: AUTO_CONFIRM_HOURS }));
    return res.status(200).json({ ...summarizeEarnings(rows), booking_count: rows.length, truncated });
  } catch (err) {
    console.error('[earnings] summary failed:', err);
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.', code: 'INTERNAL_SERVER_ERROR' });
  }
};
