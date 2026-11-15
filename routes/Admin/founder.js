import express from 'express';
import { getFounderSales, getFounderAds, getFounderInstagram, getFounderGoogle, getFounderWhatsApp, getFounderBrief, postFounderAsk } from '../../controllers/Admin/founderController.js';
import { authAdmin, authorizeAdmin, authorizeSuperAdmin } from '../../middleware/authAdminMiddleware.js';

const router = express.Router();
const superOnly = [authAdmin, authorizeAdmin, authorizeSuperAdmin];

/**
 * @swagger
 * /admin/founder/sales:
 *   get:
 *     summary: Founder dashboard sales (today, yesterday, same day last week, 14-day chart, failed, refunds). Read-only, super_admin only.
 *     tags: [Admin Founder]
 *     security:
 *       - bearerAuth: []
 */
router.get("/founder/sales", ...superOnly, getFounderSales);

/**
 * @swagger
 * /admin/founder/{source}:
 *   get:
 *     summary: Founder dashboard Phase 2 sources -- ads (Meta campaigns), instagram (reels + comments), google (Gmail unread + Calendar). Read-only, super_admin only, cached 5 min; ?refresh=1 bypasses the cache. 503 NOT_CONFIGURED when the source's keys are not set.
 *     tags: [Admin Founder]
 *     security:
 *       - bearerAuth: []
 */
router.get("/founder/ads", ...superOnly, getFounderAds);
router.get("/founder/instagram", ...superOnly, getFounderInstagram);
router.get("/founder/google", ...superOnly, getFounderGoogle);

/**
 * @swagger
 * /admin/founder/whatsapp:
 *   get:
 *     summary: Founder dashboard Phase 3 -- inbound WhatsApp messages (last 3 days) from Twilio's read-only Messages list. Numbers masked. super_admin only, cached 5 min.
 *     tags: [Admin Founder]
 *     security:
 *       - bearerAuth: []
 * /admin/founder/brief:
 *   get:
 *     summary: Founder dashboard Phase 3 -- AI brief from Gemini (cached 1 hour; ?refresh=1 forces, at most once a minute). 503 NOT_CONFIGURED without GEMINI_API_KEY.
 *     tags: [Admin Founder]
 *     security:
 *       - bearerAuth: []
 * /admin/founder/ask:
 *   post:
 *     summary: Founder dashboard Phase 3 -- ask Gemini one question ({ question }, max 500 chars) about the dashboard snapshot. Text answer only; 20 per hour. Changes nothing.
 *     tags: [Admin Founder]
 *     security:
 *       - bearerAuth: []
 */
router.get("/founder/whatsapp", ...superOnly, getFounderWhatsApp);
router.get("/founder/brief", ...superOnly, getFounderBrief);
router.post("/founder/ask", ...superOnly, postFounderAsk);

export default router;
