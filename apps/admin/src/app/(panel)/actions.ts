'use server';

import { revalidatePath } from 'next/cache';
import { dismissStuckGatewayPayment, dismissWalletResolvedDelivery } from '@levelup/db';
import { getDb } from '../../lib/db';
import { requireSession } from '../../lib/session';

/** Hide a stuck-gateway-payment row from Inicio once the client has checked it. */
export async function dismissStuckGatewayPaymentAction(formData: FormData): Promise<void> {
  // A server action is a public endpoint; the panel layout's gate does not cover it.
  await requireSession();

  const paymentId = String(formData.get('paymentId') ?? '');
  if (!paymentId) return;

  await dismissStuckGatewayPayment(getDb(), paymentId);
  revalidatePath('/');
}

/** Hide a wallet-resolved-delivery row from Inicio once the client has confirmed it. */
export async function dismissWalletResolvedDeliveryAction(formData: FormData): Promise<void> {
  await requireSession();

  const orderItemId = String(formData.get('orderItemId') ?? '');
  if (!orderItemId) return;

  await dismissWalletResolvedDelivery(getDb(), orderItemId);
  revalidatePath('/');
}
