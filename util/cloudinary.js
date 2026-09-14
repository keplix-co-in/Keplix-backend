import {v2 as cloudinary} from 'cloudinary';
cloudinary.config({
  url: process.env.CLOUDINARY_URL
})

/**
 * Deletes an asset from Cloudinary by its public_id (the full id INCLUDING
 * folder, e.g. "media_uploads/id_proof_front-<uuid>" -- exactly what
 * result.public_id on the upload response contains).
 *
 * Best-effort: never throws. A failed/asset-already-gone delete must not
 * block whatever data-erasure or replace flow is calling this -- the
 * caller has already removed its own DB reference to the asset either way.
 *
 * @param {string|null|undefined} publicId
 * @param {{resource_type?: 'image'|'video'|'raw'}} [options]
 * @returns {Promise<boolean>} true if Cloudinary reported the asset deleted (or already absent).
 */
export const destroyAsset = async (publicId, { resource_type = 'image' } = {}) => {
  if (!publicId) return false;
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type });
    // Cloudinary returns { result: 'ok' } on delete and { result: 'not found' }
    // if it's already gone -- both are a successful outcome for a caller
    // whose goal is "this asset must not exist any more".
    return result?.result === 'ok' || result?.result === 'not found';
  } catch (error) {
    console.error(`[Cloudinary] destroyAsset failed for ${publicId}:`, error.message);
    return false;
  }
};

/**
 * Extracts a Cloudinary public_id (including folder) from one of this app's
 * own delivery URLs, so a DB column that only ever stored the secure_url
 * can still be mapped back to something destroyAsset can delete.
 * Returns null for anything that doesn't look like one of our uploads.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export const publicIdFromUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  // .../upload/v<version>/media_uploads/<name>.<ext> -- strip the domain,
  // the /upload/v<version>/ prefix, and the file extension.
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)\.\w+$/);
  return match ? match[1] : null;
};

export default cloudinary;