'use client';

import { useActionState, useState } from 'react';
import type { PendingApproval } from '@levelup/db';
import { approve, reject, type ActionResult } from './actions';

interface Props {
  approval: PendingApproval;
  /** Pre-formatted on the server so the client bundle carries no Intl setup. */
  display: { price: string; received: string | null; waiting: string; diamonds: string };
}

export function ApprovalCard({ approval, display }: Props) {
  const [approveState, approveAction, approving] = useActionState<ActionResult, FormData>(
    approve,
    {},
  );
  const [rejectState, rejectAction, rejecting] = useActionState<ActionResult, FormData>(reject, {});
  const [showReject, setShowReject] = useState(false);

  const state = approveState.error || approveState.ok ? approveState : rejectState;
  const busy = approving || rejecting;

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row">
        <strong className="mono">{approval.orderNumber}</strong>
        <span className="badge muted">{display.waiting}</span>
        {approval.mismatch && <span className="badge bad">Monto distinto</span>}
        <div className="spacer" />
        <strong style={{ fontSize: 18 }}>{display.price}</strong>
      </div>

      <div style={{ color: 'var(--muted)', fontSize: 14, margin: '8px 0 12px' }}>
        {approval.comboName} · {display.diamonds} 💎 · ID{' '}
        <span className="mono">{approval.playerId}</span>
        {approval.playerNickname && <> · {approval.playerNickname}</>}
      </div>

      {approval.mismatch && (
        <div className="alert warn">
          El cliente pagó <strong>{display.received}</strong> y el combo cuesta{' '}
          <strong>{display.price}</strong>. Revisa el comprobante antes de aprobar.
        </div>
      )}

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}

      {approval.comprobanteUrl && (
        <a
          className="btn sm"
          href={approval.comprobanteUrl}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-block', marginBottom: 12 }}
        >
          Ver comprobante
        </a>
      )}

      {!showReject ? (
        <form action={approveAction}>
          <input type="hidden" name="orderId" value={approval.orderId} />
          <div className="row">
            <input
              name="amountReceived"
              type="number"
              step="0.01"
              min="0"
              placeholder="Monto recibido (opcional)"
              style={{ maxWidth: 220 }}
              disabled={busy}
            />
            {/* Only offered once a mismatch is known, so it cannot be used to
                wave through an amount nobody has actually looked at. */}
            {approval.mismatch && (
              <label className="row" style={{ gap: 6, fontSize: 13, color: 'var(--muted)' }}>
                <input type="checkbox" name="force" value="true" style={{ width: 'auto' }} />
                Aprobar de todos modos
              </label>
            )}
            <div className="spacer" />
            <button
              type="button"
              className="btn sm danger"
              onClick={() => setShowReject(true)}
              disabled={busy}
            >
              Rechazar
            </button>
            <button className="btn primary" type="submit" disabled={busy}>
              {approving ? 'Aprobando…' : 'Aprobar y recargar'}
            </button>
          </div>
        </form>
      ) : (
        <form action={rejectAction}>
          <input type="hidden" name="orderId" value={approval.orderId} />
          <div className="row">
            <input
              name="reason"
              type="text"
              placeholder="Motivo (ej. comprobante ilegible)"
              required
              autoFocus
              disabled={busy}
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => setShowReject(false)}
              disabled={busy}
            >
              Cancelar
            </button>
            <button className="btn danger" type="submit" disabled={busy}>
              {rejecting ? 'Rechazando…' : 'Confirmar rechazo'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
