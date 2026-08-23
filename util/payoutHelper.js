import Razorpay from 'razorpay';
import prisma from '../util/prisma.js';
import Logger from './logger.js';



// Initialize with Env Vars. In production, fail fast instead of silently
// falling back to placeholder credentials that would let payout calls fail
// (or worse, hit Razorpay's real test placeholders) without anyone noticing.
if (process.env.NODE_ENV === 'production') {
    const required = [
        'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',
        'RAZORPAYX_KEY_ID', 'RAZORPAYX_KEY_SECRET'
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) {
        throw new Error(`[payoutHelper] Missing required env vars in production: ${missing.join(', ')}`);
    }
}

const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'secret_placeholder'
});

const razorpayX = new Razorpay({
    key_id: process.env.RAZORPAYX_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAYX_KEY_SECRET || 'secret_placeholder'
});

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
        const contact = await razorpayX.contacts.create({
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
            fundAccount = await razorpayX.fund_accounts.create({
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
            fundAccount = await razorpayX.fund_accounts.create({
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

        // Deactivate old fund account
        await razorpayX.fund_accounts.update(existingAccount.fundAccountId, {
            active: false
        });

        let newFundAccount;

        // Create new fund account
        if (hasBankDetails) {
            newFundAccount = await razorpayX.fund_accounts.create({
                contact_id: existingAccount.contactId,
                account_type: 'bank_account',
                bank_account: {
                    // See setupVendorPayoutAccount: holder name first, then
                    // business_name for vendors who predate the column.
                    name: vendorProfile.bank_account_holder_name || vendorProfile.business_name || `Vendor ${vendorId}`,
                    ifsc: ifsc_code,
                    account_number: bank_account_number
                }
            });
        } else if (hasUpiDetails) {
            newFundAccount = await razorpayX.fund_accounts.create({
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
 * RazorpayX, based on payment.method). Auto-provisions a sandbox RazorpayX
 * fund account for the vendor if none exists yet, so admin-triggered
 * settlements don't hard-fail in non-production environments.
 *
 * Params:
 *   payment  - Payment record (needs .id, .vendorAmount, .method)
 *   vendorId - User.id of the vendor to pay out
 *
 * Returns:
 *   { success: true, payoutId, status } on success
 *   { success: false, error | message } on failure
 */
export const initiateVendorPayout = async (payment, vendorId) => {
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
             const payout = await razorpayX.payouts.create({
                 account_number: process.env.RAZORPAYX_ACCOUNT_NUMBER, // Keplix X account
                 fund_account_id: payoutAccount.fundAccountId,
                 amount: Math.round(Number(payment.vendorAmount) * 100), // paise
                 currency: "INR",
                 mode: "IMPS",
                 purpose: "payout",
                 reference_id: `payment_${payment.id}`,
             }, {
                 "X-Payout-Idempotency": `payout_payment_${payment.id}`,
             });

             return { success: true, payoutId: payout.id, status: 'paid' };
        }

        return { success: false, message: "Unknown payment method" };

    } catch (error) {
        Logger.error(`[Payout System] Error: ${error.message}`);
        return { success: false, error: error.message };
    }
};

