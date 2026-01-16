import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// @desc    Get Vendor Documents
// @route   GET /accounts/documents/
export const getDocuments = async (req, res) => {
    try {
        const docs = await prisma.document.findMany({
            where: { vendorId: req.user.id }
        });
        const formattedDocs = docs.map(doc => ({
            ...doc,
            file_url: doc.file_url ? `${req.protocol}://${req.get('host')}${doc.file_url}` : null
        }));
        res.json(formattedDocs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}

// @desc    Upload Document
// @route   POST /accounts/documents/
export const uploadDocument = async (req, res) => {
    const { document_type } = req.body;
    const file = req.file.path; // multer-cloudinary provides the file path as URL

    if (!file) return res.status(400).json({ message: "File required" });

    try {
        const doc = await prisma.document.create({
            data: {
                vendorId: req.user.id,
                document_type,
                file_url: file,
                status: 'pending'
            }
        });

        // Update profile status if needed
        // await prisma.vendorProfile.update(...)

        res.status(201).json({
            ...doc,
            file_url: `${req.protocol}://${req.get('host')}${doc.file_url}`
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error' });
    }
}
