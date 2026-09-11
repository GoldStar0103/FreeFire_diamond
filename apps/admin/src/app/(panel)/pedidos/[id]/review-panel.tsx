'use client';

import { useActionState, type FormEvent } from 'react';
import { review, type ReviewState } from './actions';

export interface ReviewPanelItem {
  itemId: string;
  sequence: number;
  status: string;
  diamondsBase: string;
  costUsd: string;
  /** Already formatted on the server, in the owner's locale. */
  sentAt: string | null;
  walletLine: string | null;
}

interface Props {
  orderId: string;
  orderStatus: string;
  items: ReviewPanelItem[];
}

const RESOLVABLE = new Set(['unknown', 'failed']);

/** One more "are you sure" in front of anything that spends or refunds money. */
const confirmFirst = (message: string) => (event: FormEvent<HTMLFormElement>) => {
  if (!window.confirm(message)) event.preventDefault();
};

/**
 * What the owner does with an order the system refused to guess about.
 *
 * Laid out in the order the job is actually done: look each recharge up in the
 * RecargasAmérica panel, say whether it landed, then resume or refund. The
 * resume button is disabled — with the reason shown — while anything is still
 * unknown, because that is the situation in which it could deliver twice.
 */
export function ReviewPanel({ orderId, orderStatus, items }: Props) {
  const [state, action, pending] = useActionState<ReviewState, FormData>(review, {});

  const unresolved = items.filter((i) => RESOLVABLE.has(i.status));
  const blocking = items.filter((i) => i.status === 'unknown' || i.status === 'sending');
  const leftToSend = items.filter((i) => i.status === 'queued' || i.status === 'failed');

  const feedback = (
    <>
      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}
    </>
  );

  if (orderStatus === 'refund_required') {
    return (
      <div className="card" style={{ borderColor: 'var(--warn)' }}>
        <h2 style={{ marginTop: 0 }}>Reembolso pendiente</h2>
        <p className="subtitle">
          Este pedido ya no enviará nada. Devuélvele el dinero al cliente y registra aquí cómo lo
          hiciste.
        </p>
        {feedback}
        <form action={action} onSubmit={confirmFirst('¿Confirmas que ya le devolviste el dinero al cliente?')}>
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="kind" value="refund_done" />
          <textarea
            name="note"
            rows={2}
            placeholder="Cómo se hizo: banco, monto y referencia"
            required
            disabled={pending}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <div className="spacer" />
            <button className="btn primary" type="submit" disabled={pending}>
              Reembolso hecho — cerrar pedido
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Resuming or completing moves the order out of review, and the page
  // re-renders without this box — which used to take the success message with
  // it, so the owner pressed the button and saw nothing happen. The component
  // stays mounted, so its state survives the re-render; keep saying what
  // happened.
  if (orderStatus !== 'needs_review') return state.ok ? <div className="alert ok">{state.ok}</div> : null;

  return (
    <div className="card" style={{ borderColor: 'var(--bad)' }}>
      <h2 style={{ marginTop: 0 }}>Resolver este pedido</h2>
      <p className="subtitle">
        El sistema no pudo confirmar todas las recargas y prefirió no adivinar. Abre el panel de
        RecargasAmérica, busca cada recarga pendiente por <strong>hora y monto</strong>, y dinos si
        llegó o no. Los diamantes enviados no se pueden recuperar: nunca adivines.
      </p>

      {feedback}

      {unresolved.map((item) => (
        <div
          key={item.itemId}
          style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}
        >
          <div className="row">
            <strong>#{item.sequence + 1}</strong>
            <span>{item.diamondsBase} 💎</span>
            <span className="badge bad">
              {item.status === 'unknown' ? 'Sin confirmar' : 'Falló'}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              {item.costUsd}
              {item.sentAt ? ` · enviada ${item.sentAt}` : ''}
            </span>
          </div>
          {item.walletLine && (
            <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{item.walletLine}</div>
          )}

          <div className="row" style={{ marginTop: 10, alignItems: 'flex-start' }}>
            <form
              action={action}
              onSubmit={confirmFirst(
                `¿Encontraste la recarga #${item.sequence + 1} en RecargasAmérica y SÍ se entregó?`,
              )}
            >
              <input type="hidden" name="orderId" value={orderId} />
              <input type="hidden" name="kind" value="mark_item_delivered" />
              <input type="hidden" name="itemId" value={item.itemId} />
              <button className="btn sm" type="submit" disabled={pending}>
                ✅ Sí llegó
              </button>
            </form>

            <form
              action={action}
              onSubmit={confirmFirst(
                `¿Confirmas que la recarga #${item.sequence + 1} NO se cobró? Se volverá a enviar.`,
              )}
              className="row"
            >
              <input type="hidden" name="orderId" value={orderId} />
              <input type="hidden" name="kind" value="mark_item_not_delivered" />
              <input type="hidden" name="itemId" value={item.itemId} />
              {/* Only an unknown outcome can hide a charge. A definite failure
                  was refused by the provider, so there is nothing to check. */}
              {item.status === 'unknown' && (
                <label className="row" style={{ gap: 6, fontSize: 13, color: 'var(--muted)' }}>
                  <input
                    type="checkbox"
                    name="confirmedNotCharged"
                    value="yes"
                    required
                    style={{ width: 'auto' }}
                  />
                  Revisé en RecargasAmérica y NO se cobró
                </label>
              )}
              <button className="btn sm danger" type="submit" disabled={pending}>
                ↩ No llegó
              </button>
            </form>
          </div>
        </div>
      ))}

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <form
          action={action}
          onSubmit={confirmFirst(
            `Se enviarán ${leftToSend.length} recarga(s) con el saldo de RecargasAmérica. ¿Continuar?`,
          )}
        >
          <input type="hidden" name="orderId" value={orderId} />
          <input type="hidden" name="kind" value="resume" />
          <div className="row">
            <button
              className="btn primary"
              type="submit"
              disabled={pending || blocking.length > 0 || leftToSend.length === 0}
            >
              Reanudar entregas
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              {blocking.length > 0
                ? 'Primero indica si llegaron las recargas sin confirmar.'
                : leftToSend.length > 0
                  ? `Envía las ${leftToSend.length} recarga(s) que faltan. Si se pausó por saldo, recarga RecargasAmérica antes.`
                  : 'No queda nada por enviar.'}
            </span>
          </div>
        </form>

        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 14 }}>
            No se puede entregar — marcar para reembolso
          </summary>
          <form
            action={action}
            onSubmit={confirmFirst('El pedido dejará de enviar recargas y quedará pendiente de reembolso. ¿Continuar?')}
            style={{ marginTop: 8 }}
          >
            <input type="hidden" name="orderId" value={orderId} />
            <input type="hidden" name="kind" value="flag_refund" />
            <textarea name="note" rows={2} placeholder="Motivo del reembolso" required disabled={pending} />
            <div className="row" style={{ marginTop: 8 }}>
              <div className="spacer" />
              <button className="btn danger" type="submit" disabled={pending}>
                Requiere reembolso
              </button>
            </div>
          </form>
        </details>
      </div>
    </div>
  );
}
