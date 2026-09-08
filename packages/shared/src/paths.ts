/**
 * Containment check for storage keys.
 *
 * Used on both sides of the comprobante flow: the storefront writing a receipt
 * and the admin panel reading it back. Pure string work, no filesystem access,
 * so it can be tested exhaustively — which matters, because the failure mode is
 * arbitrary file read or write.
 *
 * POSIX-style joining is deliberate: keys are stored in the database with
 * forward slashes regardless of which platform wrote them, so a receipt created
 * on Linux stays readable if the panel ever runs on Windows.
 */

/** Segments that must never appear in a key, however they arrive. */
const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

export type KeyResolution =
  | { ok: true; relative: string }
  | { ok: false; reason: string };

/**
 * Validate a storage key and normalise it to a safe relative path.
 *
 * Rejects absolute paths, drive letters, traversal segments, null bytes and
 * anything empty. Returns the cleaned relative path; the caller joins it to
 * whichever root it owns.
 */
export function safeStorageKey(key: string): KeyResolution {
  if (!key) return { ok: false, reason: 'empty key' };
  if (key.includes('\0')) return { ok: false, reason: 'null byte in key' };
  if (key.length > 512) return { ok: false, reason: 'key too long' };

  // Windows separators are normalised first so `..\..\` is caught by the same
  // check as `../../`.
  const normalised = key.replace(/\\/g, '/');

  if (normalised.startsWith('/')) return { ok: false, reason: 'absolute path' };
  if (/^[a-zA-Z]:/.test(normalised)) return { ok: false, reason: 'drive-qualified path' };
  if (TRAVERSAL.test(normalised)) return { ok: false, reason: 'traversal segment' };

  // Collapse redundant separators and `.` segments, then re-check: `a/./../b`
  // is only visible as traversal after normalisation.
  const segments = normalised.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return { ok: false, reason: 'empty after normalisation' };
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'traversal segment' };

  return { ok: true, relative: segments.join('/') };
}

/** Content type for a stored file, from its extension. Allowlist only. */
export function contentTypeForKey(key: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(key);
  switch (match?.[1]?.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      // Anything we did not write ourselves is not served.
      return null;
  }
}
