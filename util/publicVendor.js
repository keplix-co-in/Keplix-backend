/**
 * Safe public projection of a vendor and their profile.
 *
 * Several read endpoints did `include: { vendor: { include: { vendorProfile: true } } }`
 * and then returned the row with a spread (`res.json({ ...service })`). That
 * shipped the ENTIRE vendor and vendorProfile to the client -- including, on
 * PUBLIC unauthenticated endpoints, the vendor's bank_account_number, ifsc_code,
 * upi_id, bank_account_holder_name, email, phone, date_of_birth, and the User
 * password field. Anyone could enumerate /service_api/services/:id and harvest
 * every vendor's banking details.
 *
 * Prisma `select` is the real fix (never fetch the columns at all), but many of
 * these controllers build enriched objects that read several profile fields, so
 * an allow-list applied at serialization time is the smaller, safer change and
 * cannot be defeated by a later `...spread`. Use BOTH where practical.
 *
 * PUBLIC_VENDOR_PROFILE_SELECT — drop this into a Prisma `include`/`select` so the
 * sensitive columns never leave the database.
 *
 * publicVendor() / stripVendorSecrets() — belt-and-braces for objects that were
 * already fetched with a broad include and are about to be returned.
 */

// Columns that are safe to expose on a public (no-auth) endpoint. Deliberately a
// strict allow-list: anything not named here is withheld, so a new sensitive
// column added to the schema later is private by default rather than leaked.
export const PUBLIC_VENDOR_PROFILE_FIELDS = [
  "business_name",
  "business_type",
  "description",
  "address",
  "street",
  "area",
  "city",
  "state",
  "pincode",
  "landmark",
  "latitude",
  "longitude",
  "operating_hours",
  "breaks",
  "holidays",
  "status",
  "image",
  "cover_image",
  "is_online",
  "rating",
  "numReviews",
];

// Prisma select fragment for the public vendor profile.
export const PUBLIC_VENDOR_PROFILE_SELECT = Object.fromEntries(
  PUBLIC_VENDOR_PROFILE_FIELDS.map((f) => [f, true]),
);

// Prisma include that pulls the vendor with only public columns.
export const PUBLIC_VENDOR_INCLUDE = {
  select: {
    id: true,
    role: true,
    vendorProfile: { select: PUBLIC_VENDOR_PROFILE_SELECT },
  },
};

// Fields that must NEVER appear in any client response, on any vendor object,
// regardless of how it was fetched.
const SECRET_VENDOR_FIELDS = [
  "password",
  "bank_account_number",
  "ifsc_code",
  "upi_id",
  "bank_account_holder_name",
  "fcmToken",
  "pushToken",
  "date_of_birth",
  "gst_number",
  "otp",
  "otp_expiry",
];

/**
 * Strip secret fields from an already-fetched vendor/vendorProfile object,
 * recursively. Mutation-free: returns a shallow-cloned copy.
 *
 * Use this on the way out when a controller enriches a broadly-included object
 * and returning a fully re-selected query would be a larger change.
 */
export const stripVendorSecrets = (obj) => {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripVendorSecrets);

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_VENDOR_FIELDS.includes(key)) continue;
    clean[key] = value && typeof value === "object" ? stripVendorSecrets(value) : value;
  }
  return clean;
};
