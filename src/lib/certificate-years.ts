import { CERTIFICATE_YEAR_DATA } from "./certificate-year-data.js";

export type CertificateYearRange = { minYear: number; maxYear: number | null };
const normalizeCounty = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\bst\.?\s+/g, "saint ")
    .replace(/[^a-z0-9]/g, "");

/** Locally reviewed competitor service ranges; null maximum means today's date.
 * Missing/not-offered ranges carry no invented minimum or availability rule. */
export function certificateYearRange(
  stateCode: string,
  certificate: string,
  county: string,
): CertificateYearRange | undefined {
  const type = certificate.toLowerCase().replace(/-certificate$/, "");
  const rows = CERTIFICATE_YEAR_DATA[stateCode.toUpperCase()]?.[type];
  const key = normalizeCounty(county);
  const entry = rows && Object.hasOwn(rows, key) ? rows[key] : undefined;
  return entry ? { minYear: entry[0], maxYear: entry[1] } : undefined;
}
export function certificateDateBounds(
  stateCode: string,
  certificate: string,
  county: string,
  now = new Date(),
) {
  const range = certificateYearRange(stateCode, certificate, county);
  const today = now.toISOString().slice(0, 10);
  let max = range ? (range.maxYear ? `${range.maxYear}-12-31` : today) : undefined;
  if (certificate.toLowerCase().replace(/-certificate$/, "") === "birth") {
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const birthMax = cutoff.toISOString().slice(0, 10);
    if (!max || birthMax < max) max = birthMax;
  }
  return { min: range ? `${range.minYear}-01-01` : undefined, max };
}
