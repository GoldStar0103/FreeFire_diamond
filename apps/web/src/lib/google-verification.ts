/**
 * Search-engine / Meta HTML-tag verification tokens.
 *
 * Interpolated into `<meta name="…">` on every storefront page, so the check
 * here is the same kind of boundary as the pixel IDs: anything that does not
 * look like the token the dashboard shows is treated as unset. A store without
 * Search Console or domain verification still sells; a value that could break
 * out of the attribute is not worth taking to avoid that.
 *
 * Read per request. The layout is force-dynamic, so this follows the
 * environment rather than whatever was set when the image was built — same
 * trap as PUBLIC_DOMAIN on the sitemap.
 */

function verificationToken(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

export function googleSiteVerification(
  raw: string | undefined = process.env.GOOGLE_SITE_VERIFICATION,
): string | null {
  return verificationToken(raw);
}

/** Meta Business Manager → Brand Safety → Domains → HTML meta tag. */
export function facebookDomainVerification(
  raw: string | undefined = process.env.FACEBOOK_DOMAIN_VERIFICATION,
): string | null {
  return verificationToken(raw);
}
