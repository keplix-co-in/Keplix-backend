import express from 'express';
import { authAdmin, authorizeAdmin, authorizeSuperAdmin } from '../../middleware/authAdminMiddleware.js';
import { validateRequest } from '../../middleware/validationMiddleware.js';
import { updatePlanSchema, extendSubscriptionSchema } from '../../validators/subscriptionValidators.js';
import {
  listPlansAdmin, updatePlan, listVendorSubscriptions, extendVendorSubscription, listSubscriptionPayments,
} from '../../controllers/Admin/subscriptionController.js';

const router = express.Router();

// Garage subscriptions (2026-11-22 decision). Mounted at /admin. Reads: any admin; writes: super_admin.
router.get('/subscriptions/plans', authAdmin, authorizeAdmin, listPlansAdmin);
router.put('/subscriptions/plans/:code', authAdmin, authorizeAdmin, authorizeSuperAdmin, validateRequest(updatePlanSchema), updatePlan);
router.get('/subscriptions/vendors', authAdmin, authorizeAdmin, listVendorSubscriptions);
router.post('/subscriptions/vendors/:vendorId/extend', authAdmin, authorizeAdmin, authorizeSuperAdmin, validateRequest(extendSubscriptionSchema), extendVendorSubscription);
router.get('/subscriptions/payments', authAdmin, authorizeAdmin, listSubscriptionPayments);

export default router;
