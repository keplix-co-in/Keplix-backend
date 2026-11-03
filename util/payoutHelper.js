import prisma from '../util/prisma.js';
import Logger from './logger.js';
import { createRazorpayXClient, FAILED_PAYOUT_STATES, payoutModeFor } from './razorpayXClient.js';
import { createProxyFetch } from './proxyFetch.js';

// In production, fail fast instead of silently running without payout
// credentials (payouts would then fail days later, one by one).
if (process.env.NODE_ENV === 'production') {
    const required = [
        'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
        'RAZORPAYX_KEY_ID', 'RAZORPAYX_KEY_SECRET',
        // Without it every payout fails at send time; better to refuse to boot.
        'RAZORPAYX_ACCOUNT_NUMBER'
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) {
        throw new Error(`[payoutHelper] Missing required env vars in production: ${missing.join(', ')}`);
    }
}

// WHY a REST client and not `new Razorpay(...)`: the npm SDK has no
// contacts/payouts resources, so every payout call used to crash before
// reaching Razorpay. See util/razorpayXClient.js. Created lazily so tests
// (and the backfill script) can set env vars or inject a fake first.
let razorpayX = null;
const getClient = () => {
    if (!razorpayX) {
        // RazorpayX only accepts payout calls from allowlisted IPs and Cloud
        // Run has no fixed outbound IP, so payout calls go out through the
        // proxy on the n8n VM (see util/proxyFetch.js). Unset = direct, which
        // keeps local dev and tests unchanged.
        const proxyUrl = process.env.RAZORPAYX_PROXY_URL?.trim();
        razorpayX = createRazorpayXClient({
            keyId: process.env.RAZORPAYX_KEY_ID,
            keySecret: process.env.RAZORPAYX_KEY_SECRET,
            ...(proxyUrl ? { fetchImpl: createProxyFetch(proxyUrl) } : {}),
        });
    }
    return razorpayX;
};

/** Test-only: swap in a fake RazorpayX client (pass null to reset). */
export const __setRazorpayXClientForTests = (client) => {
    razorpayX = client;
};

/**
 * Setup RazorpayX payout account for vendor
 * Creates contact and fund account from bank/UPI details
 */
export const setupVendorPayoutAccount = async (vendorId, vendorProfile) => {
    try {
        Logger.info(`[RazorpayX] Setting up payout account for vendor ${vendorId}`);

        const { bank_account_number, ifsc_code, upi_id, business_name, bank_account_holder_name, phone, email } = vendorProfile;

        // Check if payout account already exists
        const existingAccount = await prisma.vendorPayoutAccount.findUnique({
            where: { vendorId }
        });

        if (existingAccount) {
            Logger.info(`[RazorpayX] Payout account already exists for vendor ${vendorId}`);
            return existingAccount;
        }

        // Create RazorpayX contact
        const contact = await getClient().createContact({
            name: business_name || `Vendor ${vendorId}`,
            email: email || `vendor${vendorId}@keplix.com`,
            contact: phone || '9999999999',
            type: 'vendor',
            reference_id: `vendor_${vendorId}`
        });

        Logger.info(`[RazorpayX] Created contact ${contact.id} for vendor ${vendorId}`);

        let fundAccount;

        // Create fund account based on available details
        if (bank_account_number && ifsc_code) {
            // Bank account fund account
            fundAccount = await getClient().createFundAccount({
                contact_id: contact.id,
                account_type: 'bank_account',
                bank_account: {
                    // RazorpayX validates this against the actual bank account
                    // holder, which is often not the business name. Prefer the
                    // explicitly captured holder name, falling back to
                    // business_name so vendors onboarded before the field
                    // existed keep working unchanged.
                    name: bank_account_holder_name || business_name || `Vendor ${vendorId}`,
                    ifsc: ifsc_code,
                    account_number: bank_account_number
                }
            });
            Logger.info(`[RazorpayX] Created bank fund account ${fundAccount.id} for vendor ${vendorId}`);
        } else if (upi_id) {
            // UPI fund account
            fundAccount = await getClient().createFundAccount({
                contact_id: contact.id,
                account_type: 'vpa',
                vpa: {
                    address: upi_id
                }
            });
            Logger.info(`[RazorpayX] Created UPI fund account ${fundAccount.id} for vendor ${vendorId}`);
        } else {
            throw new Error('No valid bank account or UPI details provided');
        }

        // Save to database
        const payoutAccount = await prisma.vendorPayoutAccount.create({
            data: {
                vendorId,
                contactId: contact.id,
                fundAccountId: fundAccount.id,
                isActive: true
            }
        });

        Logger.info(`[RazorpayX] Successfully set up payout account for vendor ${vendorId}`);
        return payoutAccount;

    } catch (error) {
        Logger.error(`[RazorpayX] Failed to setup payout account for vendor ${vendorId}:`, error);
        throw error;
    }
};

/**
 * Update vendor payout account when bank/UPI details change
 */
export const updateVendorPayoutAccount = async (vendorId, vendorProfile) => {
    try {
        Logger.info(`[RazorpayX] Updating payout account for vendor ${vendorId}`);

        const { bank_account_number, ifsc_code, upi_id } = vendorProfile;

        // Get existing payout account
        const existingAccount = await prisma.vendorPayoutAccount.findUnique({
            where: { vendorId }
        });

        if (!existingAccount) {
            // Create new if doesn't exist
            return await setupVendorPayoutAccount(vendorId, vendorProfile);
        }

        // Check if details changed
        const hasBankDetails = bank_account_number && ifsc_code;
        const hasUpiDetails = upi_id;

        if (!hasBankDetails && !hasUpiDetails) {
            Logger.warn(`[RazorpayX] No valid payout details for vendor ${vendorId}`);
            return existingAccount;
        }

        // WHY compare first: the vendor app's BusinessProfile screen sends the
        // bank/UPI fields on EVERY profile save, even when only the shop name
        // changed. Swapping the fund account each time would pile up
        // deactivated accounts and could swap one mid-payout. If the details
        // RazorpayX already holds match, keep the current account.
        const holderName = vendorProfile.bank_account_holder_name || vendorProfile.business_name || `Vendor ${vendorId}`;
        let current = null;
        try {
            current = await getClient().fetchFundAccount(existingAccount.fundAccountId);
        } catch (err) {
            Logger.warn(`[RazorpayX] Could not fetch fund account for vendor ${vendorId}, replacing it: ${err.message}`);
        }
        const unchanged = current && (hasBankDetails
            ? current.account_type === 'bank_account'
              && current.bank_account?.account_number === bank_account_number
              && current.bank_account?.ifsc?.toUpperCase() === String(ifsc_code).toUpperCase()
              && current.bank_account?.name === holderName
            : current.account_type === 'vpa' && current.vpa?.address === upi_id);
        if (unchanged) {
            Logger.info(`[RazorpayX] Payout details unchanged for vendor ${vendorId}; keeping fund account`);
            return existingAccount;
        }

        // Create the new fund account BEFORE deactivating the old one (it
        // used to be the other way round): if creation fails -- bad IFSC,
        // RazorpayX down -- the vendor keeps a working account instead of
        // being left with none.
        let newFundAccount;

        // Create new fund account
        if (hasBankDetails) {
            newFundAccount = await getClient().createFundAccount({
                contact_id: existingAccount.contactId,
                account_type: 'bank_account',
                bank_account: {
                    // See setupVendorPayoutAccount: holder name first, then
                    // business_name for vendors who predate the column.
                    name: holderName,
                    ifsc: ifsc_code,
                    account_number: bank_account_number
                }
            });
        } else if (hasUpiDetails) {
            newFundAccount = await getClient().createFundAccount({
                contact_id: existingAccount.contactId,
                account_type: 'vpa',
                vpa: {
                    address: upi_id
                }
            });
        }

        // Update database
        const updatedAccount = await prisma.vendorPayoutAccount.update({
            where: { vendorId },
            data: {
                fundAccountId: newFundAccount.id
            }
        });

        // Only now retire the old one. Razorpay may hand back the same id for
        // identical details, so never deactivate the account just stored. A
        // failure here is harmless (payouts use the new id), so don't fail
        // the save over it.
        if (existingAccount.fundAccountId && existingAccount.fundAccountId !== newFundAccount.id) {
            await getClient().deactivateFundAccount(existingAccount.fundAccountId).catch((err) => {
                Logger.warn(`[RazorpayX] Could not deactivate old fund account for vendor ${vendorId}: ${err.message}`);
            });
        }

        Logger.info(`[RazorpayX] Successfully updated payout account for vendor ${vendorId}`);
        return updatedAccount;

    } catch (error) {
        Logger.error(`[RazorpayX] Failed to update payout account for vendor ${vendorId}:`, error);
        throw error;
    }
};

/**
 * initiateVendorPayout
 *
 * Executes the actual gateway transfer for a vendor payout (Stripe or
 * RazorpayX, based on payment.method). A vendor without an active payout
 * account fails the payout (no placeholder fallback -- see below).
 *
 * Params:
 *   payment  - Payment record (needs .id, .vendorAmount, .method)
 *   vendorId - User.id of the vendor to pay out
 *   opts.idempotencyKey - X-Payout-Idempotency value. The worker passes a
 *     new one only after RazorpayX definitively refused the previous payout;
 *     reusing a key would just return that refused payout again.
 *
 * Returns:
 *   { success: true, payoutId, status } -- accepted. status may still be
 *     queued/pending/processing; only "processed" means the money arrived.
 *   { success: false, terminal: true, payoutId, status, error } -- RazorpayX
 *     refused this payout. Retrying with the same key cannot help.
 *   { success: false, error | message } -- anything else (network, HTTP
 *     error); safe to retry with the SAME key.
 */
export const initiateVendorPayout = async (payment, vendorId, { idempotencyKey } = {}) => {
    Logger.info(`[Payout System] Initiating Payout for Payment ID: ${payment.id}`);
    Logger.info(`[Payout System] Amount to Vendor: ${payment.vendorAmount}`);
    Logger.info(`[Payout System] Vendor ID: ${vendorId}`);

    try {
        // Get vendor's payout account
        let payoutAccount = await prisma.vendorPayoutAccount.findUnique({
            where: { vendorId }
        });

        // There used to be a fallback here that silently auto-provisioned a
        // fund account using a hardcoded bank account/IFSC when a vendor had
        // none configured, so that money could be settled even without real
        // payout details — with no NODE_ENV gate, so it applied in production
        // too. A vendor with no verified payout account must block the payout
        // rather than have money routed to a shared placeholder account.
        if (!payoutAccount || !payoutAccount.isActive) {
            throw new Error('Vendor payout account not found or inactive');
        }

        if (payment.method === 'stripe') {
            // Stripe payouts were never actually implemented — this used to
            // return a fabricated { success: true, payoutId: "tr_"+Date.now() }
            // without calling Stripe at all, which marked the payment "paid"
            // while no money moved. Stripe isn't an accepted payment method on
            // the collection side either (see controllers/vendor/paymentController.js),
            // so a payment reaching here with method 'stripe' is already a bug
            // upstream — fail loudly instead of mocking success.
            throw new Error('Stripe payouts are not implemented');
        } else if (payment.method === 'razorpay') {
             Logger.info(`[Payout System] Processing RazorpayX Transfer to ${payoutAccount.fundAccountId}`);

             // X-Payout-Idempotency ensures a retried request (network blip,
             // worker restart) that reuses the same key returns the original
             // payout instead of creating a second transfer. reference_id alone
             // is stored for search/lookup on Razorpay's side, but it is not a
             // deduplication key — only the idempotency header is.
             const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
             if (!accountNumber) {
                 throw new Error('RAZORPAYX_ACCOUNT_NUMBER is not configured');
             }
             const fundAccount = await getClient().fetchFundAccount(payoutAccount.fundAccountId);
             const payout = await getClient().createPayout({
                 account_number: accountNumber, // Keplix RazorpayX account
                 fund_account_id: payoutAccount.fundAccountId,
                 amount: Math.round(Number(payment.vendorAmount) * 100), // paise
                 currency: "INR",
                 mode: payoutModeFor(fundAccount),
                 purpose: "payout",
                 queue_if_low_balance: true,
                 reference_id: `payment_${payment.id}`,
             }, idempotencyKey || `payout_payment_${payment.id}`);

             // RazorpayX can refuse a payout in the response itself (e.g.
             // rejected for compliance). Reporting that as success would mark
             // the vendor "paid" while no money moved.
             if (FAILED_PAYOUT_STATES.includes(payout.status)) {
                 return { success: false, terminal: true, payoutId: payout.id, status: payout.status, error: describePayoutFailure(payout) };
             }

             return { success: true, payoutId: payout.id, status: payout.status };
        }

        // `error`, not `message`: the worker reads `error`, so this used to
        // surface only as "Payout failed" with no reason.
        return { success: false, error: `Unknown payment method: ${payment.method}` };

    } catch (error) {
        Logger.error(`[Payout System] Error: ${error.message}`);
        return { success: false, error: error.message };
    }
};

/** Human-readable reason for a refused/undone payout. */
export const describePayoutFailure = (payout) => {
    const reason = payout.status_details?.description || payout.failure_reason || payout.status;
    return `RazorpayX payout ${payout.id} ${payout.status}: ${reason}`;
};

/**
 * Current state of a payout on RazorpayX. Used by the worker to finish
 * payouts that were accepted but not yet processed. Throws on gateway error.
 */
export const fetchVendorPayout = (payoutId) => getClient().fetchPayout(payoutId);

