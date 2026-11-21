/**
 * GET /bills/:id/view?t=<signed token>  -- printable final bill.
 * Auth is the signed token (util/billToken.js), minted by the authenticated
 * bill-link endpoints, because a phone browser cannot send the bearer token.
 */
import crypto from 'crypto';
import prisma from '../../util/prisma.js';
import { parseIdParam } from '../../util/parseIdParam.js';
import { verifyBillToken } from '../../util/billToken.js';
import { renderBillHtml } from '../../util/billHtml.js';

const deny = (res, status, text) => res.status(status).type('text/plain').send(text);

export const viewBill = async (req, res) => {
  // The token is a bearer secret in the URL: never cache it, never leak it
  // through the Referer header, never let it be framed.
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');

  const billId = parseIdParam(req.params.id);
  const claims = verifyBillToken(req.query?.t);
  // Same answer for a bad, expired or mismatched token: no oracle on which.
  if (!billId || !claims || claims.billId !== billId) {
    return deny(res, 403, 'This bill link is invalid or has expired. Open the bill again from the Keplix app.');
  }

  try {
    const bill = await prisma.finalBill.findUnique({
      where: { id: billId },
      include: {
        lines: { orderBy: { sort_order: 'asc' } },
        booking: {
          select: {
            id: true,
            userId: true,
            service: { select: { name: true, vendorId: true, vendor: { select: { vendorProfile: { select: { business_name: true } } } } } },
            user: { select: { userProfile: { select: { name: true } } } },
            payment: { select: { status: true, platformFee: true, feeModel: true } },
            bookingQuote: { select: { tax_inclusive: true } },
          },
        },
      },
    });
    const booking = bill?.booking;
    // Re-check ownership at view time: the token proves who asked, this proves
    // they still own the booking. A void bill is no longer a bill.
    const owns = booking && (claims.role === 'vendor' ? booking.service?.vendorId === claims.actorId : booking.userId === claims.actorId);
    if (!bill || !owns || bill.status === 'void') {
      return deny(res, 404, 'Bill not found.');
    }

    const nonce = crypto.randomBytes(16).toString('base64');
    // Route-specific CSP replaces helmet's default for this page only: the one
    // inline script (print button) is allowed by nonce; nothing else may run
    // or load.
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    // The platform fee is the customer's own charge; shown on the customer
    // copy only, and only for the on-top model where it really sits on top of the bill.
    const pay = booking.payment;
    const fee = claims.role === 'user' && pay?.status === 'success' && pay.feeModel === 'on_top' ? pay.platformFee : null;

    return res.status(200).type('html').send(
      renderBillHtml({
        bill,
        taxInclusive: booking.bookingQuote?.tax_inclusive ?? true,
        garageName: booking.service?.vendor?.vendorProfile?.business_name ?? 'Garage',
        customerName: booking.user?.userProfile?.name ?? 'Customer',
        serviceName: booking.service?.name ?? '',
        bookingId: booking.id,
        platformFee: fee == null ? null : Number(fee.toString()),
        nonce,
      })
    );
  } catch (err) {
    console.error('[bills] view failed:', err);
    return deny(res, 500, 'Something went wrong. Please try again.');
  }
};
