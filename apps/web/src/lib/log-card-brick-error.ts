'use server';

/**
 * The Card Payment Brick's onError fires for failures that never reach our
 * own server at all — tokenization itself failing, before onSubmit is ever
 * called. Confirmed in production 2026-11-24: a customer's "Ha ocurrido un
 * error" had zero server-side footprint (not even a raw POST logged), while
 * the Brick's own onError was only ever sent to `console.error` — visible in
 * nobody's browser devtools but the customer's own, and gone the moment they
 * close the tab. This is the only way we ever see what the Brick itself saw.
 */
export async function logCardBrickError(input: { type: string; cause: string; message: string }): Promise<void> {
  console.error('[mercadopago-brick] client-side tokenization error (never reached createCharge)', input);
}
