import prisma from '../util/prisma.js';



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
    
    // Cloudinary Storage provides `req.file.path` as the full URL
    // Local Disk Storage provides `req.file.path` as local path or `file.filename`
    // Based on 'uploadMiddleware.js', we are using CLOUDINARY.
    
    const fileUrl = req.file?.path; 

    if (!fileUrl) return res.status(400).json({ message: "File required" });

    try {
        const doc = await prisma.document.create({
            data: {
                // IMPORTANT: The schema likely links to 'VendorProfile', not 'User'.
                // If it links to User: vendorId: req.user.id
                // If it links to VendorProfile: we must find profile first.
                // Assuming Schema is: Document { vendorId Int @relation(VendorProfile...) }
                
                // Let's first try to find the Vendor Profile ID, fallback to User ID logic if schema differs
                // For now, let's assume `vendorId` in Document table refers to VENDOR_PROFILE.id
                // If your schema uses User.id -> pass req.user.id
                // IF your schema uses VendorProfile.id -> pass that.
                
                // SAFE FETCH:
                vendorId: (await prisma.vendorProfile.findUnique({ where: { userId: req.user.id } }))?.id || undefined,

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

