import { signPrivateUrl } from "../../util/cloudinary.js";
import prisma from "../../util/prisma.js";
import { isRequiredKycDocumentType, hasRequiredKycDocuments } from "./profileController.js";



// @desc    Get Vendor Documents
// @route   GET /accounts/documents/
export const getDocuments = async (req, res) => {
    try {
        const docs = await prisma.document.findMany({
            where: { vendorId: req.user.id }
        });
        // file_url is already an absolute Cloudinary URL (see uploadDocument below) —
        // do not prefix it with req.protocol/host, that would produce a broken URL.
        // Security A-015: documents are private; the owner gets short-lived signed URLs.
        res.json(docs.map((d) => ({ ...d, file_url: signPrivateUrl(d.file_url) })));
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Upload Document
// @route   POST /accounts/documents/
export const uploadDocument = async (req, res) => {
    const { document_type } = req.body;

    // uploadMiddleware.js uses multer.memoryStorage() + uploads to Cloudinary,
    // attaching the result at req.file.cloudinary (not req.file.path, which
    // memoryStorage never sets).
    const fileUrl = req.file?.cloudinary?.secure_url;

    if (!fileUrl) return res.status(400).json({ message: "File required" });

    try {
        const doc = await prisma.document.create({
            data: {
                // Document.vendorId refers to User.id (see prisma/schema.prisma:
                // Document.vendor relation is `User @relation(fields: [vendorId], ...)`).
                vendorId: req.user.id,
                document_type,
                file_url: fileUrl,
                status: 'pending'
            }
        });

        // Review fix: the web portal (lib/onboardingSubmit.js) sends
        // onboarding_completed:true BEFORE it uploads the PAN, so the derived
        // flag came back false and the vendor was bounced to onboarding on next
        // login. Completing the flag when the required KYC document lands makes
        // the result independent of upload order. Only for a vendor whose
        // profile is filled in (business_name set), and best-effort.
        if (isRequiredKycDocumentType(document_type)) {
            try {
                const vp = await prisma.vendorProfile.findUnique({
                    where: { userId: req.user.id },
                    select: { onboarding_completed: true, business_name: true },
                });
                if (vp && !vp.onboarding_completed && vp.business_name && await hasRequiredKycDocuments(req.user.id)) {
                    await prisma.vendorProfile.update({
                        where: { userId: req.user.id },
                        data: { onboarding_completed: true },
                    });
                }
            } catch (flagError) {
                console.error("Onboarding flag update failed:", flagError);
            }
        }

        res.status(201).json({ ...doc, file_url: signPrivateUrl(doc.file_url) });
    } catch (error) {
        console.error("Document Upload Error:", error);
        // Security A-008: error.message (Prisma/driver/gateway internals) is logged, never returned.
        res.status(500).json({ message: 'Server Error' });
    }
}




