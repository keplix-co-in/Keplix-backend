import multer from "multer";
import crypto from "crypto";
import { fileTypeFromBuffer } from "file-type";
import cloudinary, { PRIVATE_UPLOAD_FIELDS } from "../util/cloudinary.js";
import streamifier from "streamifier";

// memory storage
const storage = multer.memoryStorage();

// Security A-016: fileSize alone bounded each file but not how many arrived.
// uploadAny (multer.any()) accepts any field name, so one request could carry
// hundreds of 20 MB files -- all buffered in memory on a single instance, and
// each one streamed to Cloudinary. Cap files and non-file fields too.
// 20 files covers the largest real form (health sheets: one photo per
// component, admin-configurable but single digits today; booking updates
// allow 10 images).
export const UPLOAD_LIMITS = {
  fileSize: 20 * 1024 * 1024,
  // Review fix: was 20. VehicleInspection.jsx (vendor app) allows 2 photos
  // per checklist item and every active component (admin-configurable) plus
  // each walk-in service is an item, so 10+ items already exceeded 20 and the
  // whole health sheet -- which gates job completion -- failed with
  // LIMIT_FILE_COUNT. 40 = 20 items x 2 photos; still bounded.
  files: 40,
  fields: 100,
  fieldSize: 1024 * 1024,
};

const multerUpload = multer({
  storage,
  limits: UPLOAD_LIMITS,
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
        // A 13-digit millisecond timestamp with a known fieldName prefix
        // (e.g. "id_proof_front-1731000000000") is enumerable, not
        // unguessable -- identity documents and other private uploads sat
        // at a predictable public delivery URL. crypto.randomUUID() is not
        // retroactive for anything already uploaded under the old scheme.
        public_id: `${fieldName}-${crypto.randomUUID()}`,
        // Security A-015: identity/KYC documents are uploaded as
        // 'authenticated' assets, which Cloudinary will not serve without a
        // signature. Readers get a short-lived signed link built at response
        // time (util/cloudinary.js signPrivateUrl). Files uploaded before this
        // change stay public; only new uploads are private.
        ...(PRIVATE_UPLOAD_FIELDS.has(fieldName) ? { type: "authenticated" } : {}),
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

/**
 * Accepts any field name, unlike uploadFieldss which needs a fixed
 * [{name,maxCount}] list known at route-definition time. Needed for health
 * sheets: components come from the HealthComponent template table (an admin
 * can add a 6th without a deploy), so the set of valid field names —
 * `photo_<component.key>` — can change at runtime. multer.any() puts results
 * in req.files as an ARRAY (not an object keyed by field name, like
 * uploadFieldss produces) — every field is grouped by fieldname downstream in
 * the caller, not here, since only the caller knows which field names are
 * actually valid components.
 */
export const uploadAny = () => [
  multerUpload.any(),
  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) return next();

      for (const file of req.files) {
        file.cloudinary = await processFile(file, file.fieldname);
      }

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