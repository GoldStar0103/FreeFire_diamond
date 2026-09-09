/**
 * Serve a public flyer.
 *
 * Flyers are uploaded through the admin panel into UPLOAD_DIR, which sits
 * outside anything the web server exposes — deliberately, because comprobantes
 * live in the same volume and those must never be reachable by URL. So the
 * public half needs a door of its own, and this is it: flyers only, images
 * only, read-only.
 *
 * Unlike the comprobante route, the path here comes from the request rather
 * than from a database lookup, so the containment checks are load-bearing
 * rather than belt-and-braces.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { contentTypeForKey, safeStorageKey, uploadRoot } from '@levelup/shared';
import { FLYER_PREFIX } from '../../../lib/assets';

/** Images only. A PDF is a valid stored type but not something to inline here. */
const SERVEABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function GET(_request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;

  const safe = safeStorageKey(key.join('/'));
  if (!safe.ok) return new Response('No encontrado', { status: 404 });

  // The prefix check is the whole security boundary: without it this route
  // serves `comprobantes/...` to anyone who asks.
  if (!safe.relative.startsWith(FLYER_PREFIX)) return new Response('No encontrado', { status: 404 });

  const contentType = contentTypeForKey(safe.relative);
  if (!contentType || !SERVEABLE.has(contentType)) {
    return new Response('No encontrado', { status: 404 });
  }

  let rootPath: string;
  try {
    rootPath = uploadRoot();
  } catch (err) {
    console.error(`[media] ${err instanceof Error ? err.message : String(err)}`);
    return new Response('Almacenamiento no configurado', { status: 500 });
  }

  const filePath = resolve(join(rootPath, safe.relative));

  // safeStorageKey works on strings; this catches what it cannot see, such as a
  // symlink inside the upload volume pointing back out of it.
  if (!filePath.startsWith(rootPath + sep)) {
    console.error(`[media] resolved outside upload root: ${safe.relative}`);
    return new Response('No encontrado', { status: 404 });
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return new Response('No encontrado', { status: 404 });

    const bytes = await readFile(filePath);

    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(info.size),
        // Every key carries a UUID, so a given URL's bytes never change — a new
        // flyer is a new key. That makes this safely immutable, which matters:
        // the flyer is the heaviest thing on a page served to phones on mobile
        // data, and it is the same image for every visitor all month.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; object-src 'none'",
      },
    });
  } catch {
    return new Response('No encontrado', { status: 404 });
  }
}
