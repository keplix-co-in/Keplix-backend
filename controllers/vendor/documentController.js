import prisma from "../../util/prisma.js";



// @desc    Get Vendor Documents
// @route   GET /accounts/documents/
export const getDocuments = async (req, res) => {
    try {
        const docs = await prisma.document.findMany({
            where: { vendorId: req.user.id }
        });
        // file_url is already an absolute Cloudinary URL (see uploadDocument below) —
        // do not prefix it with req.protocol/host, that would produce a broken URL.
        res.json(docs);
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

        res.status(201).json(doc);
    } catch (error) {
        console.error("Document Upload Error:", error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
}




