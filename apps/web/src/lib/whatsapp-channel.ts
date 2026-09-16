/**
 * The WhatsApp channel invite for the site-wide "join our community" popup.
 *
 * Distinct from `vip.ts`'s group invite: a WhatsApp *channel* link lives at
 * `whatsapp.com/channel/<code>`, not `chat.whatsapp.com/<code>` — different
 * product, different host, so it needs its own validator rather than reusing
 * that one. Same reasoning as `vip.ts` for why this is validated at all: an
 * env var typo should never become an arbitrary href rendered to every visitor.
 */
const CHANNEL_HOST = 'whatsapp.com';

export function whatsappChannelUrl(
  raw: string | undefined = process.env.WHATSAPP_CHANNEL_URL,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== CHANNEL_HOST) return null;

  const segments = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segments.length !== 2 || segments[0] !== 'channel') return null;
  const code = segments[1]!;
  if (!/^[A-Za-z0-9]{10,64}$/.test(code)) return null;

  return `https://${CHANNEL_HOST}/channel/${code}`;
}
