import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findCustomerOrder, type CustomerOrder, type CustomerOrderStatus } from '@levelup/db';
import { getCustomerSession } from '../../../lib/customer-session';
import { callerIp, getDb, lookupLimiter } from '../../../lib/server';
import { applyStripeReport, getStripe, STRIPE } from '../../../lib/stripe';
import { AutoRefresh, PurchasePixel } from './live';
import { diamonds, mxn } from '../../../lib/format';
import { vipGroupUrl } from '../../../lib/vip';
import { supportUrl } from '../../../lib/support';

export const dynamic = 'force-dynamic';

/**
 * Never indexed. The URL carries a Free Fire player ID and the page shows what
 * they bought and what they paid — indexed, that is a searchable record of
 * someone's purchases tied to their game account.
 *
 * next.config.mjs already sends `X-Robots-Tag: noindex` for this path and
 * robots.txt disallows it. This is the third layer, and the cheapest.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

const STATUS: Record<CustomerOrderStatus, { label: string; detail: string; tone: string }> = {
  esperando_pago: {
    label: 'Esperando tu pago',
    detail: 'Sube tu comprobante para que podamos continuar.',
    tone: 'warn',
  },
  pago_en_revision: {
    label: 'Revisando tu pago',
    detail: 'Ya recibimos tu comprobante. En cuanto lo validemos entra tu recarga.',
    tone: 'warn',
  },
  procesando: {
    label: 'Recargando tus diamantes',
    detail: 'Tu pago quedó confirmado. Los diamantes están entrando a tu cuenta.',
    tone: 'ok',
  },
  completado: {
    label: '¡Listo! Diamantes entregados',
    detail: 'Revisa tu cuenta de Free Fire. ¡Gracias por tu compra!',
    tone: 'ok',
  },
  con_problema: {
    label: 'Estamos revisando tu pedido',
    detail: 'Algo no salió como esperábamos. Ya lo estamos atendiendo personalmente.',
    tone: 'bad',
  },
  cancelado: { label: 'Pedido cancelado', detail: 'Este pedido ya no está activo.', tone: 'muted' },
};

type TrackerStepState = 'done' | 'active' | 'pending' | 'error';

const TRACKER_LABELS = [
  'Recibimos tu pedido',
  'Confirmando tu pago',
  'Entregando tus diamantes',
  '¡Listo! Diamantes entregados',
] as const;

/**
 * Where the order sits on the four-stage tracker in the mockup ("Panel de
 * Seguimiento").
 *
 * `con_problema` and `cancelado` are not later stages of the same journey —
 * they are the two ways it stops early — so they freeze the tracker at the
 * stage that actually broke instead of pretending the rest is still coming.
 * `needs_review`/`refund_required` (con_problema) only happen after the
 * engine has already spent the customer's money trying to fulfil the order,
 * so payment is done and delivery is what failed; every other terminal path
 * (expired, rejected) stops before delivery ever starts, at payment.
 *
 * `completedAt` overrides all of that: a delivered order can still land back
 * in `refund_required` later (a dispute after the fact), and by then delivery
 * genuinely happened — freezing step 3 as an error would contradict the real
 * timestamp step 4 is about to show right below it.
 */
function trackerStates(status: CustomerOrderStatus, completedAt: Date | null): TrackerStepState[] {
  if (completedAt) return ['done', 'done', 'done', 'done'];

  switch (status) {
    case 'esperando_pago':
    case 'pago_en_revision':
      return ['done', 'active', 'pending', 'pending'];
    case 'procesando':
      return ['done', 'done', 'active', 'pending'];
    case 'completado':
      return ['done', 'done', 'done', 'done'];
    case 'con_problema':
      return ['done', 'done', 'error', 'pending'];
    case 'cancelado':
      return ['done', 'error', 'pending', 'pending'];
  }
}

const WHEN = new Intl.DateTimeFormat('es-MX', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** What "waiting for payment" means depends on how they chose to pay. */
const CARD_WAITING = {
  label: 'Confirmando tu pago',
  detail: 'Si ya pagaste con tarjeta, esto tarda solo unos segundos. No cierres esta página.',
  tone: 'warn',
};
const OXXO_WAITING = {
  label: 'Paga tu ficha en OXXO',
  detail:
    'Presenta tu ficha en cualquier OXXO y paga en efectivo. En cuanto se acredite, tu recarga entra sola — puede tardar unas horas.',
  tone: 'warn',
};
const SPEI_WAITING = {
  label: 'Paga por transferencia SPEI',
  detail:
    'Usa los datos de abajo para transferir desde tu banco. En cuanto se acredite, tu recarga entra sola — puede tardar unas horas.',
  tone: 'warn',
};

type BankTransfer = {
  hostedInstructionsUrl: string | null;
  clabe: string | null;
  bankName: string | null;
  reference: string | null;
};

/**
 * Ask Stripe directly when a card order is still waiting.
 *
 * The webhook is the real confirmation, but it is also the part most likely to
 * be misconfigured on day one, and it can lag. The customer has just paid and
 * is looking at this page; asking costs one request and turns "why does it say
 * waiting" into their diamonds arriving. Idempotent with the webhook.
 */
async function reconcileCard(
  order: CustomerOrder,
): Promise<{ voucherUrl: string | null; bankTransfer: BankTransfer | null }> {
  const none = { voucherUrl: null, bankTransfer: null };
  const gateway = getStripe();
  if (!gateway || order.gateway !== STRIPE || !order.gatewayChargeId) return none;
  if (order.status !== 'esperando_pago') return none;

  try {
    const snapshot = await gateway.getCharge(order.gatewayChargeId);
    if (!snapshot) return none;

    const issued = Boolean(snapshot.voucherUrl) || Boolean(snapshot.bankTransfer);
    if (snapshot.state !== 'pending' || issued) {
      await applyStripeReport({
        gatewayChargeId: snapshot.gatewayChargeId,
        state: snapshot.state,
        amountReceivedCents: snapshot.amountReceivedCents,
        reference: snapshot.reference ?? null,
        voucherIssued: issued,
      });
    }
    if (snapshot.state !== 'pending') return none;
    return {
      voucherUrl: snapshot.voucherUrl ?? null,
      bankTransfer: snapshot.bankTransfer ?? null,
    };
  } catch (err) {
    // The webhook will get there. Showing the page matters more.
    console.error(`[pedido] could not re-check ${order.orderNumber} with Stripe`, err);
    return none;
  }
}

export default async function OrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNumber: string }>;
  searchParams: Promise<{ id?: string }>;
}) {
  const { orderNumber } = await params;
  const { id } = await searchParams;

  // No accounts: the order number plus the player ID is the whole
  // authorisation model, so both must be present.
  if (!id) notFound();

  let order = await findCustomerOrder(getDb(), orderNumber, id);
  if (!order) {
    // This page performs the identical order-number+player-ID pairing check
    // `pedidos/actions.ts`'s `lookupOrder` exists to rate-limit, and is
    // directly navigable — it's the redirect target of every checkout and of
    // that very form — so it was reachable at an unlimited rate by skipping
    // the form. Unlike the form, this page also has to serve its own AutoRefresh
    // polling every few seconds while an order is processing, so the limiter is
    // only ever consumed on a MISS, never on a hit: a customer's own valid
    // order — the same pairing, over and over — can never trip it, while a
    // guess against unrelated order numbers looks exactly like the thing
    // `lookupOrder` already throttles, and shares its budget with it.
    lookupLimiter.check(await callerIp());
    notFound();
  }

  const { voucherUrl, bankTransfer } = await reconcileCard(order);
  if (order.status === 'esperando_pago' && order.gateway === STRIPE) {
    // The re-check may just have confirmed it.
    order = (await findCustomerOrder(getDb(), orderNumber, id)) ?? order;
  }

  const byCard = order.gateway === STRIPE;
  const status =
    order.status === 'esperando_pago' && byCard
      ? voucherUrl
        ? OXXO_WAITING
        : bankTransfer
          ? SPEI_WAITING
          : CARD_WAITING
      : STATUS[order.status];

  // Paid orders fire the browser Purchase; everything else is not a sale yet.
  const paid = order.status === 'procesando' || order.status === 'completado';
  // Keep refreshing while something is about to change on its own, including
  // an issued OXXO voucher or SPEI reference: those now open in a separate
  // tab (Stripe's own hosted page), so refreshing this one no longer disturbs
  // anyone trying to read a barcode or copy a CLABE off of it — the client
  // asked for this specifically so people can watch their order advance here
  // while they pay in the other tab.
  const refreshing = order.status === 'procesando' || (byCard && order.status === 'esperando_pago');
  const pct =
    order.advertisedDiamonds === 0
      ? 0
      : Math.min(100, (order.deliveredDiamonds / order.advertisedDiamonds) * 100);

  const helpUrl = supportUrl(
    `Hola, tengo un problema con mi pedido ${order.orderNumber} (ID ${order.playerId}).`,
  );

  // Only once the diamonds are actually in their account. Inviting someone to
  // the VIP group while their order is still processing would read as a sales
  // pitch at the exact moment they are waiting to find out if we delivered.
  const vipUrl = order.status === 'completado' ? vipGroupUrl() : null;
  const session = await getCustomerSession();

  return (
    <main className="page narrow">
      {refreshing && <AutoRefresh everyMs={5_000} />}
      {paid && (
        <PurchasePixel
          orderNumber={order.orderNumber}
          eventId={order.eventId}
          value={order.priceMxnCents / 100}
          comboKey={order.comboKey}
        />
      )}

      <div className={`card status-card ${status.tone}`}>
        <div className="status-label">{status.label}</div>
        <p className="status-detail">{status.detail}</p>
        {order.status === 'cancelado' && order.cancelReason && (
          <p className="status-detail">Motivo: {order.cancelReason}</p>
        )}

        {voucherUrl && (
          <a className="btn primary wide" href={voucherUrl} target="_blank" rel="noreferrer">
            Ver mi ficha OXXO
          </a>
        )}

        {bankTransfer && (
          <div className="pay-box" style={{ marginTop: 12 }}>
            {bankTransfer.clabe && (
              <div className="pay-row">
                <span>CLABE</span>
                <strong className="mono">{bankTransfer.clabe}</strong>
              </div>
            )}
            {bankTransfer.bankName && (
              <div className="pay-row">
                <span>Banco</span>
                <strong>{bankTransfer.bankName}</strong>
              </div>
            )}
            {bankTransfer.reference && (
              <div className="pay-row">
                <span>Referencia</span>
                <strong className="mono">{bankTransfer.reference}</strong>
              </div>
            )}
            {bankTransfer.hostedInstructionsUrl && (
              <a
                className="btn primary wide"
                style={{ marginTop: 12 }}
                href={bankTransfer.hostedInstructionsUrl}
                target="_blank"
                rel="noreferrer"
              >
                Ver instrucciones de transferencia
              </a>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <ol className="tracker">
          {TRACKER_LABELS.map((label, i) => {
            const state = trackerStates(order.status, order.completedAt)[i];
            return (
              <li key={label} className={`tracker-step ${state}`}>
                <span className="tracker-dot">
                  {state === 'done' ? '✓' : state === 'error' ? '✕' : ''}
                </span>
                <div className="tracker-text">
                  <div className="tracker-label">{label}</div>
                  {i === 0 && <div className="tracker-time">{WHEN.format(order.createdAt)}</div>}
                  {i === 2 && order.status === 'procesando' && (
                    <div className="tracker-time">
                      {diamonds(order.deliveredDiamonds)} de {diamonds(order.advertisedDiamonds)} 💎 (
                      {Math.round(pct)}%)
                    </div>
                  )}
                  {i === 3 && order.completedAt && (
                    <div className="tracker-time">{WHEN.format(order.completedAt)}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="card">
        <dl className="kv">
          <dt>Pedido</dt>
          <dd className="mono">{order.orderNumber}</dd>
          <dt>Paquete</dt>
          <dd>{order.comboName}</dd>
          <dt>Diamantes</dt>
          <dd>{diamonds(order.advertisedDiamonds)} 💎</dd>
          <dt>Cuenta</dt>
          <dd>
            {order.playerNickname ?? '—'}
            <div className="hint mono">ID {order.playerId}</div>
          </dd>
          <dt>Total</dt>
          <dd>{mxn(order.priceMxnCents)}</dd>
        </dl>
      </div>

      {/* Support appears only when an order actually needs a human. The client
          does not want a floating WhatsApp button in a market full of curious
          children — this is the one place it shows up. */}
      {order.needsSupport && helpUrl && (
        <a className="btn primary wide" href={helpUrl} target="_blank" rel="noreferrer">
          Escríbenos por WhatsApp
        </a>
      )}

      {!session && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2 className="mini-title">Crea tu cuenta Mi LevelUp</h2>
          <p className="hint">
            Ya compraste como invitado. Con una cuenta, esta recarga y las siguientes suman al
            Level Pass y desbloquean La Bóveda.
          </p>
          <Link className="btn primary wide" href="/cuenta">
            Crear mi cuenta
          </Link>
        </div>
      )}

      {vipUrl && (
        <div className="card vip">
          <div className="vip-title">🎁 Únete al grupo VIP</div>
          <p className="vip-text">
            Promos exclusivas, sorteos y los combos nuevos antes que nadie. Solo para clientes
            que ya compraron.
          </p>
          <a className="btn primary wide" href={vipUrl} target="_blank" rel="noreferrer">
            Entrar al grupo VIP
          </a>
        </div>
      )}

      <p className="hint center">
        Guarda este enlace para volver a consultar tu pedido.
      </p>
      <Link href="/" className="back center">
        ← Volver a la tienda
      </Link>
    </main>
  );
}
