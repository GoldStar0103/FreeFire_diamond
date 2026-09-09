/**
 * The WhatsApp support link.
 *
 * Three places built this inline as `https://wa.me/${process.env.X ?? ''}`,
 * which produces `https://wa.me/` when the number is unset — a link that opens
 * a WhatsApp error page. The worst of the three sits on a failed order, so the
 * customer whose recharge did not arrive clicks the one button offered to them
 * and lands nowhere.
 *
 * Returning null instead lets each caller hide the link rather than show a
 * broken one. Support is deliberately not a floating button — the footer and a
 * failed order are the only two places it appears, and the client asked for
 * that: their market is full of curious children.
 */

/** wa.me wants digits only: country code, no +, no spaces, no dashes. */
export function supportNumber(raw: string | undefined = process.env.WHATSAPP_SUPPORT_NUMBER): string | null {
  const digits = raw?.replace(/\D/g, '') ?? '';
  // Shortest plausible international number is around 8 digits; anything under
  // that is a misconfiguration rather than a real number.
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function supportUrl(
  message?: string,
  raw: string | undefined = process.env.WHATSAPP_SUPPORT_NUMBER,
): string | null {
  const number = supportNumber(raw);
  if (!number) return null;

  return message
    ? `https://wa.me/${number}?text=${encodeURIComponent(message)}`
    : `https://wa.me/${number}`;
}
