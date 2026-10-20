/** URL context is descriptive only; grant verification always determines access. */
export function recoveryUrl(
  frontendUrl: string,
  token: string,
  order?: { stateSlug: string; certificate: string } | null,
): string {
  const certificate = order?.certificate.toLowerCase();
  const scoped =
    order &&
    /^[a-z]+(?:-[a-z]+)*$/.test(order.stateSlug) &&
    ["birth", "death", "marriage", "divorce"].includes(certificate!);
  return `${frontendUrl.replace(/\/$/, "")}/${scoped ? `resume-${order.stateSlug}-${certificate}-certificate` : "resume"}#${token}`;
}
