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
export const destroyAsset = async (publicId, { resource_type = 'image', type } = {}) => {
  if (!publicId) return false;
  // Security A-015: private documents are uploaded with type 'authenticated'
  // and Cloudinary only deletes them when told that type. Accept a full
  // delivery URL too, so callers holding only the stored URL delete the right
  // asset whatever its delivery type / resource type.
  if (typeof publicId === 'string' && /^https?:\/\//.test(publicId)) {
    const parsed = parseCloudinaryUrl(publicId);
    if (!parsed) return false;
    publicId = parsed.publicId;
    resource_type = parsed.resourceType;
    type = parsed.type;
  }
  try {
    const result = await cloudinary.uploader.destroy(publicId, type ? { resource_type, type } : { resource_type });
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
export const publicIdFromUrl = (url) => parseCloudinaryUrl(url)?.publicId ?? null;

/**
 * Security A-015: parse one of our delivery URLs, including the
 * `/authenticated/` (private) delivery type that publicIdFromUrl used to
 * miss -- it only matched `/upload/`, so private assets could not be found
 * for erasure.
 *
 * https://res.cloudinary.com/<cloud>/<resource>/<type>/[s--sig--/][v123/]<public_id>.<ext>
 *
 * @param {string|null|undefined} url
 * @returns {{publicId: string, resourceType: string, type: string, format: string|null}|null}
 */
export const parseCloudinaryUrl = (url) => {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(
    /\/(image|video|raw)\/(upload|authenticated|private)\/(?:s--[^/]+--\/)?(?:v\d+\/)?([^?#]+?)(?:\.(\w+))?(?:[?#].*)?$/
  );
  if (!match) return null;
  const [, resourceType, type, rest, ext] = match;
  // Raw assets keep their extension as part of the public_id.
  if (resourceType === 'raw') {
    return { publicId: ext ? `${rest}.${ext}` : rest, resourceType, type, format: null };
  }
  return { publicId: rest, resourceType, type, format: ext || null };
};

const cloudName = () => {
  try {
    return cloudinary.config().cloud_name || null;
  } catch {
    return null;
  }
};

/**
 * Security A-014: true only for assets in OUR Cloudinary account. Profile,
 * service, blog and offer endpoints used to store any URL a client put in
 * the body, which let anyone point their avatar / ID proof / blog cover at
 * an attacker-controlled host (tracking pixels, phishing, content we never
 * moderated, or a URL that later serves something else).
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export const isOwnCloudinaryUrl = (url) => {
  const name = cloudName();
  if (!name || typeof url !== 'string') return false;
  return url.startsWith(`https://res.cloudinary.com/${name}/`);
};

/**
 * Security A-014: filter a URL supplied in a request body.
 *   - our own Cloudinary URL -> returned as-is
 *   - null / '' (an explicit "clear this image") -> returned as-is
 *   - anything else -> undefined, i.e. "field not supplied", so the caller
 *     leaves the stored value untouched.
 *
 * @param {unknown} url
 * @returns {string|null|undefined}
 */
export const acceptOwnCloudinaryUrl = (url) => {
  if (url === null || url === '') return url;
  return isOwnCloudinaryUrl(url) ? url : undefined;
};

/** How long a signed private-document link stays valid. */
export const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * Security A-015: turn a stored private (`/authenticated/`) asset URL into a
 * short-lived signed download link. Public (`/upload/`) URLs -- everything
 * uploaded before this change, and all non-sensitive images -- are returned
 * unchanged.
 *
 * ONLY call this when building a response for the document's owner or an
 * admin. The stored URL itself is useless without a signature, so leaking
 * it is harmless; leaking the signed result is not.
 *
 * @param {string|null|undefined} url
 * @param {{ttlSeconds?: number}} [options]
 * @returns {string|null|undefined}
 */
export const signPrivateUrl = (url, { ttlSeconds = SIGNED_URL_TTL_SECONDS } = {}) => {
  const parsed = parseCloudinaryUrl(url);
  if (!parsed || parsed.type !== 'authenticated') return url;
  try {
    return cloudinary.utils.private_download_url(parsed.publicId, parsed.format || '', {
      type: 'authenticated',
      resource_type: parsed.resourceType,
      expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
  } catch (error) {
    console.error('[Cloudinary] signPrivateUrl failed:', error.message);
    return null;
  }
};

/**
 * Field names whose uploads are identity / KYC documents and must never sit
 * at a public delivery URL (Security A-015).
 */
export const PRIVATE_UPLOAD_FIELDS = new Set(['id_proof_front', 'id_proof_back', 'file_url']);

export default cloudinary;