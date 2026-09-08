/**
 * Comprobante upload validation.
 *
 * This is a public, unauthenticated endpoint — anyone who can reach the
 * storefront can post bytes at it — so the rules here are the only thing
 * between the internet and the server's disk.
 *
 * The important one: the declared Content-Type is attacker-controlled and is
 * never trusted. The file type is decided by sniffing magic bytes, and the
 * stored filename and extension are derived from THAT, never from anything the
 * client sent. A PHP script announcing itself as image/jpeg gets rejected on
 * its bytes; a file called `x.jpg.php` never keeps its name.
 */

export type UploadKind = 'jpeg' | 'png' | 'webp' | 'pdf';

/** What a phone camera or a banking app actually produces. */
const EXTENSIONS: Record<UploadKind, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  pdf: 'pdf',
};

const MIME_TYPES: Record<UploadKind, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** Comfortably above a phone photo, well below anything worth worrying about. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((byte, i) => bytes[offset + i] === byte);

/**
 * Identify a file by its contents.
 *
 * Returns null for anything not on the list, which is the whole point — an
 * allowlist means an unrecognised format is rejected rather than passed through.
 */
export function detectUploadKind(bytes: Uint8Array): UploadKind | null {
  if (bytes.length < 12) return null;

  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';

  // PNG: 89 "PNG" CR LF SUB LF
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';

  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }

  // PDF: "%PDF-"
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';

  return null;
}

export type UploadRejection =
  | { code: 'EMPTY'; message: string }
  | { code: 'TOO_LARGE'; message: string; maxBytes: number }
  | { code: 'UNSUPPORTED_TYPE'; message: string };

export type UploadValidation =
  | { ok: true; kind: UploadKind; mimeType: string; extension: string; byteLength: number }
  | { ok: false; rejection: UploadRejection };

export function validateUpload(
  bytes: Uint8Array,
  maxBytes = MAX_UPLOAD_BYTES,
): UploadValidation {
  if (bytes.length === 0) {
    return { ok: false, rejection: { code: 'EMPTY', message: 'El archivo está vacío.' } };
  }

  if (bytes.length > maxBytes) {
    return {
      ok: false,
      rejection: {
        code: 'TOO_LARGE',
        message: `El archivo pesa más de ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        maxBytes,
      },
    };
  }

  const kind = detectUploadKind(bytes);
  if (!kind) {
    return {
      ok: false,
      rejection: {
        code: 'UNSUPPORTED_TYPE',
        // Deliberately not echoing the declared type back — it is untrusted input.
        message: 'Solo se aceptan fotos (JPG, PNG, WEBP) o PDF.',
      },
    };
  }

  return {
    ok: true,
    kind,
    mimeType: MIME_TYPES[kind],
    extension: EXTENSIONS[kind],
    byteLength: bytes.length,
  };
}

/**
 * Storage path for a comprobante.
 *
 * Built entirely from values we control — the order number and a random id —
 * so nothing the uploader sent can influence where the file lands. The order
 * number is sanitised anyway rather than trusted to be well-formed.
 */
export function comprobantePath(
  orderNumber: string,
  extension: string,
  randomId: string,
): string {
  const safeOrder = orderNumber.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32) || 'sin-pedido';
  const safeId = randomId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  const safeExt = extension.replace(/[^a-z0-9]/g, '').slice(0, 5);
  return `comprobantes/${safeOrder}/${safeId}.${safeExt}`;
}
