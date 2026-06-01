import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import cloudinary from "../util/cloudinary.js";
import streamifier from "streamifier";

// memory storage
const storage = multer.memoryStorage();

const multerUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

// COMMON FUNCTION (reuse for single & multiple)
const processFile = async (file, fieldName) => {
  const fileType = await fileTypeFromBuffer(file.buffer);

  if (!fileType) {
    throw new Error("Unable to determine file type");
  }

  if (!ALLOWED_TYPES.includes(fileType.mime)) {
    throw new Error(`Invalid file type: ${fileType.mime}`);
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "media_uploads",
        resource_type: "auto",
        public_id: `${fieldName}-${Date.now()}`,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );

    streamifier.createReadStream(file.buffer).pipe(stream);
  });
};

// SINGLE FILE
export const uploadSingle = (fieldName) => [
  multerUpload.single(fieldName),
  async (req, res, next) => {
    try {
      if (!req.file) return next();

      const result = await processFile(req.file, fieldName);
      req.file.cloudinary = result;

      next();
    } catch (err) {
      next(err);
    }
  },
];

// MULTIPLE FILES 
export const uploadFieldss = (fields) => [
  multerUpload.fields(fields),
  async (req, res, next) => {
    try {
      if (!req.files) return next();

      const processedFiles = {};

      for (const fieldName in req.files) {
        processedFiles[fieldName] = [];

        for (const file of req.files[fieldName]) {
          const result = await processFile(file, fieldName);
          file.cloudinary = result;
          processedFiles[fieldName].push(file);
        }
      }

      req.files = processedFiles;

      next();
    } catch (err) {
      next(err);
    }
  },
];