/**
 * Which ad pixels are switched on, and with what ID.
 *
 * Both IDs are interpolated into inline scripts (meta-pixel.tsx,
 * tiktok-pixel.tsx), so the checks here are not tidiness: they are the only
 * thing between a configuration value and code that runs on every page of the
 * store. Anything that does not look exactly like an ID is treated as unset.
 * A store without a pixel still sells; a script assembled from whatever got
 * pasted into an env var is not a risk worth taking to avoid that.
 *
 * Read per request, like the legal identity: every storefront page is
 * force-dynamic, so this follows the environment rather than whatever was set
 * when the image was built.
 */

/** Meta's Pixel ID is the long number in Events Manager. */
export function metaPixelId(raw: string | undefined = process.env.META_PIXEL_ID): string | null {
  const value = raw?.trim() ?? '';
  return /^\d{8,20}$/.test(value) ? value : null;
}

/**
 * TikTok's pixel code is uppercase letters and digits — 20 characters today,
 * e.g. `C4ABCDEFGHIJKLMNOPQR`.
 *
 * The length is allowed some slack so a longer code in future does not
 * silently switch tracking off; the character set is what makes the value
 * safe to put inside a script, and that stays strict. Lowercase is rejected
 * rather than upper-cased: the code is meant to be copied out of Ads Manager,
 * and a value that something has altered may have been altered in other ways.
 */
export function tiktokPixelId(raw: string | undefined = process.env.TIKTOK_PIXEL_ID): string | null {
  const value = raw?.trim() ?? '';
  return /^[A-Z0-9]{16,32}$/.test(value) ? value : null;
}
