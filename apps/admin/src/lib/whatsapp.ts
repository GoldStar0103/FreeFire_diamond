/**
 * WhatsApp deep links for the admin panel.
 *
 * The storefront hit this exact bug once already (see `apps/web/src/lib/
 * support.ts`): building `https://wa.me/${number}` inline, with no check,
 * produces `https://wa.me/` for an unset or unusable number — a button that
 * opens a WhatsApp error page instead of a chat. `contactWhatsapp` on an order
 * is optional and customer-typed, so the same shape of bug is possible here.
 * `waNumber` returns null instead, and every call site is expected to render
 * nothing when it does.
 *
 * Apps in this repo don't share code across the `apps/*` boundary, so this
 * re-implements the same small cleaning logic rather than importing it.
 */

/** wa.me wants digits only: country code, no +, no spaces, no dashes. */
export function waNumber(raw: string | null | undefined): string | null {
  const digits = raw?.replace(/\D/g, '') ?? '';
  // Shortest plausible international number is around 8 digits; anything under
  // that is a typo or a placeholder, not a real number.
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function waUrl(raw: string | null | undefined, message?: string): string | null {
  const number = waNumber(raw);
  if (!number) return null;

  return message
    ? `https://wa.me/${number}?text=${encodeURIComponent(message)}`
    : `https://wa.me/${number}`;
}

/**
 * Spanish opener text for the WhatsApp button, by where it is shown.
 *
 * Kept short and conversational — the owner is about to keep typing in the
 * same chat, so this is an opener, not the whole message.
 */
export function orderWhatsappMessage(
  order: {
    orderNumber: string;
    comboName?: string | null | undefined;
    advertisedDiamonds?: number | null | undefined;
  },
  kind: 'general' | 'mismatch',
  extra?: { receivedMxn?: string | undefined; expectedMxn?: string | undefined },
): string {
  const combo =
    order.comboName && order.advertisedDiamonds
      ? ` (${order.comboName}, ${order.advertisedDiamonds} 💎)`
      : order.comboName
        ? ` (${order.comboName})`
        : '';

  if (kind === 'mismatch') {
    const amounts =
      extra?.receivedMxn && extra?.expectedMxn
        ? ` Nos llegó ${extra.receivedMxn} y tu pedido es de ${extra.expectedMxn}.`
        : ' El monto que nos llegó no coincide con el de tu pedido.';
    return `Hola, te escribo por tu pedido ${order.orderNumber}${combo}.${amounts} ¿Me ayudas a revisarlo antes de continuar?`;
  }

  return `Hola, quiero platicarte sobre tu pedido ${order.orderNumber}${combo}.`;
}
