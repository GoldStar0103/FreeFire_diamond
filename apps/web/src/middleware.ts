import { NextResponse, type NextRequest } from 'next/server';
import { supportUrl } from './lib/support';

/**
 * A kill switch for the storefront, independent of a deploy.
 *
 * Toggled by setting MAINTENANCE_MODE=true in .env and restarting the web
 * container — no code change, no rebuild. Added for the kind of incident
 * where the provider itself is unreliable and the right move is to stop
 * taking new orders rather than let them queue up behind a problem on their
 * side. Payment webhooks stay open so a payment made just before the switch
 * flips still gets reconciled instead of landing in limbo.
 */
export function middleware(): NextResponse {
  if (process.env.MAINTENANCE_MODE !== 'true') return NextResponse.next();

  const whatsapp = supportUrl('Hola, vi que la tienda está en mantenimiento, tengo una duda.');

  return new NextResponse(maintenanceHtml(whatsapp), {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Tells search engines and any polite bot this is temporary, not a
      // reason to drop the site from the index.
      'retry-after': '43200',
    },
  });
}

export const config = {
  matcher: [
    '/((?!_next/|api/webhooks/|api/health|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};

function maintenanceHtml(whatsapp: string | null): string {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>En mantenimiento · LevelUp Store</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0d0f1a; color:#f4f4f6; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    padding:24px; box-sizing:border-box; text-align:center; }
  .card { max-width:420px; }
  h1 { font-size:22px; margin:0 0 12px; }
  p { color:#b7b9c4; line-height:1.5; margin:0 0 20px; }
  a.btn { display:inline-block; background:#25d366; color:#0d0f1a; font-weight:600; text-decoration:none;
    padding:12px 20px; border-radius:10px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Estamos en mantenimiento</h1>
    <p>Volvemos en breve. Si ya hiciste un pedido, no te preocupes — se procesa en cuanto reactivemos el servicio.</p>
    ${whatsapp ? `<a class="btn" href="${whatsapp}" target="_blank" rel="noreferrer">Escríbenos por WhatsApp</a>` : ''}
  </div>
</body>
</html>`;
}
