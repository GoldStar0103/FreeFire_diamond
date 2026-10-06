/**
 * Sending the OTP code over WhatsApp.
 *
 * This is the one piece of the Level Pass account system that cannot be
 * fully verified from here: it calls Meta's WhatsApp Cloud API, which needs
 * (a) the business's WhatsApp Business Platform access approved, and (b) a
 * message template submitted and approved by Meta — business-initiated
 * WhatsApp messages cannot use free-form text outside a 24-hour customer
 * service window. As of this engagement's own history, that access was still
 * being set up (see the Meta Business Verification work earlier), so
 * `MetaWhatsAppSender` below is written correctly against Meta's documented
 * Cloud API shape but has not been exercised against a real approved
 * template. Swap the template name/component shape for whatever Meta
 * actually approves before relying on it.
 *
 * `WhatsAppSender` is the port both implementations satisfy, same pattern as
 * `Alerter` in the engine package: callers depend on the interface, not on
 * which one is wired up.
 */

export interface WhatsAppSender {
  /** `to` is normalised E.164 digits, no `+` — see customer-auth.ts's `normaliseWhatsapp`. */
  sendOtpCode(to: string, code: string): Promise<void>;
}

/** Local/dev default: prints the code instead of sending it, so signup can be tested with no credentials at all. */
export class ConsoleWhatsAppSender implements WhatsAppSender {
  async sendOtpCode(to: string, code: string): Promise<void> {
    console.log(`[whatsapp:dev] OTP for +${to}: ${code}`);
  }
}

export interface MetaWhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** The name of the Meta-approved template that carries the one-time code. */
  templateName: string;
  languageCode: string;
}

export class WhatsAppSendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'WhatsAppSendError';
  }
}

export class MetaWhatsAppSender implements WhatsAppSender {
  constructor(private readonly config: MetaWhatsAppConfig) {}

  async sendOtpCode(to: string, code: string): Promise<void> {
    const url = `https://graph.facebook.com/v21.0/${this.config.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: this.config.templateName,
          language: { code: this.config.languageCode },
          components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }],
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new WhatsAppSendError(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`, res.status);
    }
  }
}

/**
 * Built on first use, so a missing config fails at the point something
 * actually wants to send a message — same reasoning as `getProvider()` in
 * server.ts — rather than at build time or on every unrelated page load.
 */
export function buildWhatsAppSender(env = process.env): WhatsAppSender {
  const phoneNumberId = env.WHATSAPP_CLOUD_PHONE_ID?.trim();
  const accessToken = env.WHATSAPP_CLOUD_ACCESS_TOKEN?.trim();
  const templateName = env.WHATSAPP_OTP_TEMPLATE_NAME?.trim();

  if (!phoneNumberId || !accessToken || !templateName) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'WHATSAPP_CLOUD_PHONE_ID, WHATSAPP_CLOUD_ACCESS_TOKEN and WHATSAPP_OTP_TEMPLATE_NAME are required in production',
      );
    }
    return new ConsoleWhatsAppSender();
  }

  return new MetaWhatsAppSender({
    phoneNumberId,
    accessToken,
    templateName,
    languageCode: env.WHATSAPP_OTP_TEMPLATE_LANG?.trim() || 'es_MX',
  });
}
