/**
 * Serve a comprobante to a signed-in admin.
 *
 * The URL carries a payment id, never a path. The storage key is looked up from
 * the database, so nothing the caller sends can influence which file is read —
 * path traversal is not merely blocked here, it has no way in.
 *
 * Receipts show a name, a bank account and an amount. They are stored outside
 * anything the web server exposes and only ever leave through this route.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { payments } from '@levelup/db';
import { contentTypeForKey, safeStorageKey } from '@levelup/shared';
import { db } from '../../../../lib/db';
import { getSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  // Route handlers are not covered by the panel layout's gate.
  const session = await getSession();
  if (!session) return new Response('No autorizado', { status: 401 });

  const { paymentId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) {
    return new Response('Solicitud inválida', { status: 400 });
  }

  const [payment] = await db
    .select({ key: payments.comprobanteAssetUrl })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);

  if (!payment?.key) return new Response('No hay comprobante', { status: 404 });

  const safe = safeStorageKey(payment.key);
  if (!safe.ok) {
    // A key already in the database failing validation means something wrote a
    // value it should not have. Refuse and make it visible.
    console.error(`[comprobante] rejected stored key for payment ${paymentId}: ${safe.reason}`);
    return new Response('Comprobante no disponible', { status: 500 });
  }

  const contentType = contentTypeForKey(safe.relative);
  if (!contentType) return new Response('Tipo de archivo no soportado', { status: 415 });

  const root = process.env.UPLOAD_DIR;
  if (!root) {
    console.error('[comprobante] UPLOAD_DIR is not set');
    return new Response('Almacenamiento no configurado', { status: 500 });
  }

  const rootPath = resolve(root);
  const filePath = resolve(join(rootPath, safe.relative));

  // Belt and braces after safeStorageKey: symlinks and odd volume mappings can
  // still land outside the root, and this is the last check before a read.
  if (filePath !== rootPath && !filePath.startsWith(rootPath + sep)) {
    console.error(`[comprobante] resolved outside upload root: ${safe.relative}`);
    return new Response('Comprobante no disponible', { status: 500 });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new Response('Comprobante no disponible', { status: 404 });

    const bytes = await readFile(filePath);

    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(info.size),
        // Inline so an admin can glance at it, but never cached by a proxy and
        // never sniffed into something executable.
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; object-src 'none'",
      },
    });
  } catch {
    return new Response('Comprobante no disponible', { status: 404 });
  }
}
