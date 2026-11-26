/**
 * Reactivate an already-expired gateway payment from the command line —
 * the CLI counterpart of the admin panel's "Reactivar pedido vencido" tool
 * (apps/admin's `reactivateExpiredPayment`), for when there is no admin
 * session at hand. See that action's own doc comment for the real incident
 * this exists for: a Stripe card authorized fine, but the final status
 * arrived after this app's own deadline had already passed.
 *
 * Never trusts the caller's own say-so: re-verifies the reference directly
 * with the named gateway and refuses outright unless that gateway's own
 * answer is `paid` for THIS order specifically, same discipline the admin
 * tool follows.
 *
 *   DATABASE_URL=... pnpm --filter @levelup/worker reactivate-expired-payment \
 *     <orderId> <orderNumber> <stripe|mercadopago|mercadopago-embedded> <reference> [adminUserId]
 */

import { createDb, DrizzlePaymentStore } from '@levelup/db';
import { approvePayment, type GatewayChargeState } from '@levelup/engine';
import { MercadoPagoEmbeddedGateway, MercadoPagoGateway, StripeGateway } from '@levelup/payments';

const [orderId, orderNumber, gatewayName, reference, adminUserId] = process.argv.slice(2);

if (!orderId || !orderNumber || !gatewayName || !reference) {
  throw new Error(
    'Usage: reactivate-expired-payment <orderId> <orderNumber> <stripe|mercadopago|mercadopago-embedded> <reference> [adminUserId]',
  );
}

async function checkGateway(reference: string): Promise<{
  state: GatewayChargeState;
  amountReceivedCents: number | null;
  orderNumber: string | null;
}> {
  if (gatewayName === 'stripe') {
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secretKey || !webhookSecret) throw new Error('Stripe is not configured in this environment.');
    const snapshot = await new StripeGateway({ secretKey, webhookSecret }).getCharge(reference);
    if (!snapshot) throw new Error('Stripe has no charge with that reference.');
    return { state: snapshot.state, amountReceivedCents: snapshot.amountReceivedCents, orderNumber: snapshot.orderNumber ?? null };
  }

  if (gatewayName === 'mercadopago-embedded') {
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
    const webhookSecret = process.env.MERCADOPAGO_EMBEDDED_WEBHOOK_SECRET?.trim();
    if (!accessToken || !webhookSecret) throw new Error('Mercado Pago embedded is not configured in this environment.');
    const snapshot = await new MercadoPagoEmbeddedGateway({ accessToken, webhookSecret }).getCharge(reference);
    if (!snapshot) throw new Error('Mercado Pago has no order with that id.');
    return { state: snapshot.state, amountReceivedCents: snapshot.amountReceivedCents, orderNumber: snapshot.orderNumber ?? null };
  }

  if (gatewayName === 'mercadopago') {
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
    const webhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
    if (!accessToken || !webhookSecret) throw new Error('Mercado Pago Checkout Pro is not configured in this environment.');
    const snapshot = await new MercadoPagoGateway({ accessToken, webhookSecret }).getPaymentById(reference);
    if (!snapshot) throw new Error('Mercado Pago has no payment with that reference.');
    return { state: snapshot.state, amountReceivedCents: snapshot.amountReceivedCents, orderNumber: snapshot.orderNumber ?? null };
  }

  throw new Error(`Unknown gateway "${gatewayName}" — expected stripe, mercadopago, or mercadopago-embedded.`);
}

const found = await checkGateway(reference);

if (found.orderNumber !== orderNumber) {
  throw new Error(
    found.orderNumber
      ? `That reference belongs to order ${found.orderNumber}, not ${orderNumber} — refusing.`
      : `That reference is not tied to any order — refusing.`,
  );
}
if (found.state !== 'paid') {
  throw new Error(`The gateway still reports this payment as "${found.state}", not paid — refusing to reactivate.`);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const { db, client } = createDb(databaseUrl);

try {
  const result = await approvePayment(
    { store: new DrizzlePaymentStore(db) },
    {
      orderId,
      adminUserId: adminUserId ?? null,
      ...(found.amountReceivedCents !== null ? { amountReceivedCents: found.amountReceivedCents } : {}),
      reference,
      reactivateExpired: true,
    },
  );

  if (result.ok) {
    console.log(
      result.alreadyApproved
        ? `${result.orderNumber} was already confirmed.`
        : `${result.orderNumber} reactivated and confirmed — the worker will deliver it.`,
    );
  } else {
    console.error(`Could not reactivate: ${result.failure.code} — ${result.failure.message}`);
    process.exitCode = 1;
  }
} finally {
  await client.end({ timeout: 5 });
}
