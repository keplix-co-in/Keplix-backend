import express from 'express';
import prisma from '../../util/prisma.js';
import { isOfferLive, toPublicOffer } from '../../util/offers.js';
import Logger from '../../util/logger.js';

const router = express.Router();

/**
 * @swagger
 * /content/offers:
 *   get:
 *     summary: Live promotional content, keyed by placement
 *     tags: [Public]
 *     responses:
 *       200:
 *         description: Only slots that are active and inside their date window
 */

/**
 * Deliberately public (no `protect`): the home banner renders before a user logs
 * in, and the marketing site may consume the same content later.
 *
 * Being public is exactly why the filtering matters — only LIVE slots may leave
 * this endpoint. A slot that is inactive, not yet started, or expired must be
 * invisible, otherwise scheduling a future campaign would leak it early to
 * anyone who curls the URL.
 */
router.get('/offers', async (req, res) => {
  try {
    // Cheap pre-filter in SQL; the date window is applied in JS through the
    // shared helper so the admin view and this endpoint use one definition of
    // "live" rather than two that can drift apart.
    const slots = await prisma.offerSlot.findMany({
      where: { is_active: true },
      orderBy: { display_order: 'asc' },
      include: { targets: { select: { vendorId: true } } },
    });

    const now = new Date();
    const data = slots.filter((s) => isOfferLive(s, now)).map(toPublicOffer);

    // Promotional copy changes rarely and is identical for everyone, but a
    // scheduled slot must go live without a long wait, so keep the window short.
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({ data });
  } catch (error) {
    Logger.error(`[Offers] public offers failed: ${error.message}`);
    // An empty list rather than a 500: every client falls back to its built-in
    // copy, so a failure here degrades to the old hardcoded text instead of
    // breaking the screen.
    return res.json({ data: [] });
  }
});

export default router;
