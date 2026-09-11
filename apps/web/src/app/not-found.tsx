import Link from 'next/link';

/**
 * 404.
 *
 * Most 404s here are not typos in the address bar. They are a customer opening
 * their order link with a truncated URL — WhatsApp and Instagram both mangle
 * long links — or a combo that was live when they saw the flyer and has since
 * been rotated out. Both of those people have money involved, so the page
 * routes them to the order lookup rather than just apologising.
 *
 * `force-dynamic` for the same reason the legal pages are: Next's auto-
 * generated `/_not-found` route reads the root layout's env-derived config
 * (the Meta/TikTok pixel ids, the WhatsApp support link) at render time, and
 * without this it is the one route in the app that gets prerendered at BUILD
 * time — when the container image builds with no environment at all, per
 * README. A visitor who lands here (which, per the comment above, is most of
 * them) would silently get no pixel and no WhatsApp link, baked in until the
 * next rebuild.
 */
export const dynamic = 'force-dynamic';
export default function NotFound() {
  return (
    <main className="page narrow">
      <div className="card status-card">
        <div className="status-label">No encontramos esta página</div>
        <p className="status-detail">
          Puede que el enlace esté incompleto o que la promoción ya haya terminado.
        </p>
      </div>

      <div className="card">
        <p style={{ margin: 0, fontSize: 15 }}>
          ¿Buscabas tu pedido? Búscalo con tu número de pedido y tu ID de jugador.
        </p>
      </div>

      <Link className="btn primary wide" href="/pedidos">
        Consultar mi pedido
      </Link>

      <Link className="btn wide" href="/" style={{ marginTop: 10 }}>
        Ver las promociones del mes
      </Link>
    </main>
  );
}
