/** Device city/region resolved from the filling device's IP at payment time.
 *
 *  Uses the keyless ipwho.is endpoint (HTTPS, commercial use allowed,
 *  1,000 lookups/day per server IP — far above paid-order volume).
 *  IP geolocation is approximate (ISP routing and VPNs can shift it), so
 *  this feeds a staff display line only — never eligibility or fraud logic.
 *
 *  Privacy: only the returned city/region strings leave this module. The
 *  raw IP is never stored, never logged, and never sent anywhere except
 *  the lookup itself. All failures yield null so ordering never blocks.
 */

export interface DeviceLocation {
  city: string;
  region: string;
}

const ENDPOINT = "https://ipwho.is/";
const DEFAULT_TIMEOUT_MS = 2500;

function isPublicIp(host: string): boolean {
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4).
  const normalized = host.toLowerCase().startsWith("::ffff:") ? host.slice("::ffff:".length) : host;
  if (!normalized || normalized === "unknown") return false;
  if (normalized === "::1" || normalized === "localhost") return false;
  const parts = normalized.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
    return true;
  }
  // IPv6 global unicast only (2000::/3); everything else is special-purpose.
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  return Number.isInteger(first) && first >= 0x2000 && first < 0x4000;
}

export async function resolveDeviceLocation(
  ip: unknown,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DeviceLocation | null> {
  if (typeof ip !== "string") return null;
  const host = ip.split(",")[0]?.trim() ?? "";
  if (!isPublicIp(host)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${ENDPOINT}${encodeURIComponent(host)}?fields=success,city,region`,
      { signal: controller.signal },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      city?: unknown;
      region?: unknown;
    };
    if (body.success !== true) return null;
    const city = typeof body.city === "string" ? body.city.trim() : "";
    const region = typeof body.region === "string" ? body.region.trim() : "";
    if (!city && !region) return null;
    return { city, region };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
