import { listPendingApprovals } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { diamonds, mxn, relativeTime } from '../../../lib/format';
import { ApprovalCard } from './approval-card';

// Money is arriving continuously; a cached queue would show stale work.
export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  await requireSession();
  const approvals = await listPendingApprovals(getDb());

  return (
    <>
      <h1>Aprobaciones</h1>
      <p className="subtitle">
        Pedidos esperando que confirmes el pago. Al aprobar, la recarga se hace sola.
      </p>

      {approvals.length === 0 ? (
        <div className="card empty">No hay pagos pendientes por revisar.</div>
      ) : (
        approvals.map((approval) => (
          <ApprovalCard
            key={approval.orderId}
            approval={approval}
            display={{
              price: mxn(approval.priceMxnCents),
              received:
                approval.amountReceivedCents === null
                  ? null
                  : mxn(approval.amountReceivedCents),
              waiting: relativeTime(approval.createdAt),
              diamonds: diamonds(approval.advertisedDiamonds),
            }}
          />
        ))
      )}
    </>
  );
}
