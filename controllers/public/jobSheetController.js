import prisma from '../../util/prisma.js';

/**
 * This URL travels over SMS/WhatsApp and lives forever in message history —
 * forwarded, screenshotted, cached by link-preview bots. It is unauthenticated
 * by design (that's the point: a walk-in customer has no account to log into),
 * so what it returns has to be safe to leak. No phone numbers, no email, no
 * internal ids, no vendor bank/GST data, registration masked to last 4.
 */
const maskRegistration = (reg) => {
  if (!reg || reg.length <= 4) return reg ?? '';
  return `${'•'.repeat(reg.length - 4)}${reg.slice(-4)}`;
};

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || '';

function shapeHealthSheet(sheet) {
  if (!sheet) return null;
  return {
    odometer_km: sheet.odometer_km,
    overall_notes: sheet.overall_notes,
    submitted_at: sheet.submitted_at,
    items: sheet.items.map((item) => ({
      // `label` is the denormalised display name, set for both component and
      // service items. The component fallback covers rows written before that
      // column existed. This used to dereference item.component.label directly,
      // which throws outright on a service item — the public page 500s rather
      // than degrading.
      component: item.label ?? item.component?.label ?? 'Item',
      status: item.status,
      price: item.price,
      notes: item.notes,
      photos: item.photos,
    })),
  };
}

// @desc    Public tracking page data for a walk-in job or a booking's health
//          sheet, resolved by the unguessable token sent in SMS/WhatsApp.
// @route   GET /content/job-sheet/:token
export const getJobSheetByToken = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Public link previews (WhatsApp/iMessage unfurls, etc.) must not cause
  // this customer data to be indexed anywhere.
  res.set('X-Robots-Tag', 'noindex');

  const { token } = req.params;

  try {
    // The customer gets this link at check-in, before any health sheet
    // exists — so the token has to resolve against WalkInJob first (it's
    // always present) and fall back to a HealthSheet's own token (the case
    // for a Booking, which has no token of its own; see HealthSheet in
    // schema.prisma).
    const job = await prisma.walkInJob.findUnique({
      where: { public_token: token },
      include: {
        vehicle: { select: { registration: true, make: true, model: true } },
        vendor: { select: { vendorProfile: { select: { business_name: true, city: true } } } },
        healthSheet: { include: { items: { include: { component: true } } } },
      },
    });

    if (job) {
      return res.json({
        type: 'walk_in',
        status: job.status,
        customer_first_name: firstName(job.customer_name),
        vehicle: job.vehicle
          ? {
              registration: maskRegistration(job.vehicle.registration),
              make: job.vehicle.make,
              model: job.vehicle.model,
            }
          : null,
        garage: {
          name: job.vendor?.vendorProfile?.business_name || 'Keplix partner garage',
          city: job.vendor?.vendorProfile?.city || null,
        },
        description: job.description,
        amount_collected: job.amount_collected,
        started_at: job.started_at,
        completed_at: job.completed_at,
        health_sheet: shapeHealthSheet(job.healthSheet),
      });
    }

    const sheet = await prisma.healthSheet.findUnique({
      where: { public_token: token },
      include: {
        items: { include: { component: true } },
        booking: {
          select: {
            status: true,
            user: { select: { userProfile: { select: { name: true } } } },
            service: { select: { name: true, vendor: { select: { vendorProfile: { select: { business_name: true, city: true } } } } } },
          },
        },
      },
    });

    if (sheet && sheet.booking) {
      return res.json({
        type: 'booking',
        status: sheet.booking.status,
        customer_first_name: firstName(sheet.booking.user?.userProfile?.name),
        service_name: sheet.booking.service?.name,
        garage: {
          name: sheet.booking.service?.vendor?.vendorProfile?.business_name || 'Keplix partner garage',
          city: sheet.booking.service?.vendor?.vendorProfile?.city || null,
        },
        health_sheet: shapeHealthSheet(sheet),
      });
    }

    // Deliberately the same generic 404 whether the token is malformed,
    // unknown, or belonged to something now deleted — nothing here should
    // help distinguish those cases.
    return res.status(404).json({ message: 'Not found' });
  } catch (error) {
    return res.status(500).json({ message: 'Server Error' });
  }
};
