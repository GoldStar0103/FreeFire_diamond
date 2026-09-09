import Link from 'next/link';
import { getDashboardStats, getPaymentDetails } from '@levelup/db';
import { getDb } from '../../lib/db';
import { requireSession } from '../../lib/session';
import { mxn } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  await requireSession();
  const [stats, payTo] = await Promise.all([
    getDashboardStats(getDb()),
    getPaymentDetails(getDb()),
  ]);

  return (
    <>
      <h1>Inicio</h1>
      <p className="subtitle">Resumen de hoy.</p>

      {/* All of these mean money is not being made right now, so they sit
          above the numbers rather than below them. */}
      {!payTo && (
        // First, because it is the only one that stops every sale outright.
        // The storefront will not show payment details it does not have, so
        // until this is set nobody can complete a purchase.
        <div className="alert bad">
          <strong>La tienda no puede recibir pagos.</strong> No hay una cuenta configurada, así
          que los clientes ven un aviso para escribirte por WhatsApp en lugar de los datos de
          pago.{' '}
          <Link href="/ajustes" style={{ textDecoration: 'underline' }}>
            Configúrala en Ajustes
          </Link>
          .
        </div>
      )}

      {stats.missingProducts.length > 0 && (
        <div className="alert bad">
          <strong>Faltan productos del proveedor:</strong>{' '}
          {stats.missingProducts.join(', ')} 💎. Los combos que los usan no se pueden
          entregar. Corre la sincronización del catálogo.
        </div>
      )}

      {stats.inactiveCombos.length > 0 && (
        <div className="alert warn">
          <strong>{stats.inactiveCombos.length} combo(s) apagados</strong> porque entregan
          menos de lo que anuncian:{' '}
          {stats.inactiveCombos.map((c) => c.name).join(', ')}.{' '}
          <Link href="/combos" style={{ textDecoration: 'underline' }}>
            Revisar combos
          </Link>
        </div>
      )}

      <div className="stat-grid">
        <Link href="/aprobaciones" className="card">
          <div className="stat-label">Esperando aprobación</div>
          <div className={`stat-value${stats.awaitingApproval > 0 ? ' bad' : ''}`}>
            {stats.awaitingApproval}
          </div>
        </Link>

        <div className="card">
          <div className="stat-label">Procesando</div>
          <div className="stat-value">{stats.processing}</div>
        </div>

        <Link href="/pedidos?filtro=needs_attention" className="card">
          <div className="stat-label">Requieren revisión</div>
          <div className={`stat-value${stats.needsReview > 0 ? ' bad' : ''}`}>
            {stats.needsReview}
          </div>
        </Link>

        <div className="card">
          <div className="stat-label">Completados hoy</div>
          <div className="stat-value ok">{stats.completedToday}</div>
        </div>

        <div className="card">
          <div className="stat-label">Vendido hoy</div>
          <div className="stat-value">{mxn(stats.revenueTodayCents)}</div>
        </div>
      </div>
    </>
  );
}
