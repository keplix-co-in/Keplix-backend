import { REQUIRED_KYC_DOCUMENTS, KYC_DOCUMENT_ALIASES } from "../controllers/vendor/profileController.js";

// WHY: the admin approval gate and the admin detail view must agree on what
// "onboarding complete" means, so both use this one function.
const filled = (v) => typeof v === "string" ? v.trim().length > 0 : v !== null && v !== undefined;

export const computeOnboarding = (profile, documents = []) => {
  const p = profile || {};
  const have = new Set((documents || []).map((d) => String(d.document_type || "").trim().toLowerCase()));
  const missing = [];
  if (!filled(p.business_name)) missing.push("business_name");
  if (!filled(p.owner_name)) missing.push("owner_name");
  if (!filled(p.phone)) missing.push("phone");
  if (!filled(p.address) && !filled(p.street)) missing.push("address");
  if (!filled(p.city)) missing.push("city");
  if (!filled(p.pincode)) missing.push("pincode");
  if (!filled(p.latitude) || !filled(p.longitude)) missing.push("location");
  if (!filled(p.operating_hours)) missing.push("operating_hours");
  const hasBank = filled(p.bank_account_number) && filled(p.ifsc_code);
  if (!hasBank && !filled(p.upi_id)) missing.push("bank_or_upi");
  for (const req of REQUIRED_KYC_DOCUMENTS) {
    if (!(KYC_DOCUMENT_ALIASES[req] || [req]).some((a) => have.has(a))) missing.push(`document:${req}`);
  }
  return { complete: missing.length === 0, missing };
};

export const maskTail = (v) => {
  if (!filled(v)) return null;
  const s = String(v);
  return s.length <= 4 ? "****" : `${"*".repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
};
