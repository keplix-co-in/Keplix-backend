import express from 'express';
import {
  listOfferSlotsAdmin,
  createOfferSlot,
  updateOfferSlot,
  upsertOfferSlotByKey,
  setOfferSlotTargets,
  deleteOfferSlot,
} from '../../controllers/Admin/offerController.js';
import { authAdmin, authorizeAdmin } from '../../middleware/authAdminMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import {
  createOfferSlotSchema,
  updateOfferSlotSchema,
  setOfferTargetsSchema,
} from '../../validators/Admin/offerValidator.js';

const router = express.Router();

/**
 * Admin CRUD for promotional placement slots. Mounted at /admin.
 *
 * Every route is authAdmin + authorizeAdmin, and every write is validated —
 * matching routes/Admin/healthComponents.js, which is the house pattern for
 * admin-managed content tables.
 */

router.get('/offer-slots', authAdmin, authorizeAdmin, listOfferSlotsAdmin);

router.post(
  '/offer-slots',
  authAdmin,
  authorizeAdmin,
  validateRequest(createOfferSlotSchema),
  createOfferSlot
);

router.patch(
  '/offer-slots/:id',
  authAdmin,
  authorizeAdmin,
  validateRequest(updateOfferSlotSchema),
  updateOfferSlot
);

// Addressed by placement key, so the admin can edit a placement whose row
// doesn't exist yet. Declared before the /:id routes so 'by-key' can never be
// parsed as an id.
router.put(
  '/offer-slots/by-key/:key',
  authAdmin,
  authorizeAdmin,
  validateRequest(updateOfferSlotSchema),
  upsertOfferSlotByKey
);

router.put(
  '/offer-slots/:id/targets',
  authAdmin,
  authorizeAdmin,
  validateRequest(setOfferTargetsSchema),
  setOfferSlotTargets
);

router.delete('/offer-slots/:id', authAdmin, authorizeAdmin, deleteOfferSlot);

export default router;
