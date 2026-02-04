import multer from 'multer';
import path from 'path';
import cloudinary from '../util/cloudinary.js';
import { CloudinaryStorage } from 'multer-storage-cloudinary';


const checkFileType = (file, cb) => {
    // Allowed extensions - expanded
    const filetypes = /jpg|jpeg|png|heic|webp|pdf|doc|docx/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    // Check mime type (looser check for docs & images)
    // Cloudinary usually handles types well.
    // If mime type is octet-stream (sometimes happens with form-data), rely on extension.
    const mimetype = filetypes.test(file.mimetype) ||
                     file.mimetype === 'application/pdf' ||
                     file.mimetype === 'application/msword' ||
                     file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                     file.mimetype === 'application/octet-stream';

    if (extname || mimetype) { 
        return cb(null, true);
    } else {
        cb(new Error(`Images/Docs only. Got: ${file.mimetype} / ${path.extname(file.originalname)}`));
    }
};


// cloudinary storage setup
const storage = new CloudinaryStorage({
    cloudinary,
    params:{
        folder: "media_uploads",
        resource_type: "auto",
        public_id: (req,file)=> `${file.fieldname}-${Date.now()}`
    },
});



// multer configuration
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: function (req, file, cb) {
        checkFileType(file, cb);
    },
})
export default upload;
