export const CALIFORNIA_DIVORCE_UNAVAILABLE_MESSAGE =
  "California Divorce Certificate is not available through our online service. This applies to all counties in California.";

/** Only new requests are blocked; do not use for recovery or stored checkout. */
export function isNewCertificateUnavailable(stateCode: string, certificate: string): boolean {
  return stateCode.trim().toUpperCase() === "CA" && certificate === "DIVORCE";
}
