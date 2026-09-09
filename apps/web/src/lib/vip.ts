/**
 * The VIP WhatsApp group invite.
 *
 * Shown on a completed order and nowhere else. That placement is the whole
 * idea: the invite is a thank-you to someone who has just bought, at the one
 * moment they are pleased with us, rather than a banner competing for attention
 * with the buy button. It also means the group fills with buyers instead of
 * browsers, which is what makes it worth anything as a sales channel.
 *
 * The link is configuration because the client rotates it — a WhatsApp invite
 * can be revoked from inside the group, and when it is, the old URL silently
 * leads nowhere. Leaving it unset hides the block entirely rather than shipping
 * a dead button.
 */

/**
 * WhatsApp invite codes are 22 URL-safe characters today, but that is an
 * undocumented implementation detail, so the length is not pinned — only the
 * shape. Query parameters are dropped: copying an invite from the app tacks on
 * share-source tracking (`?s=sh&p=i&…`) that says how the client copied it, not
 * anything the customer needs.
 */
const INVITE_HOST = 'chat.whatsapp.com';

export function vipGroupUrl(raw: string | undefined = process.env.WHATSAPP_VIP_GROUP_URL): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // An href is an injection point. Anything that is not an https link to the
  // real WhatsApp host is dropped rather than rendered — a typo in an env var
  // should not become a `javascript:` URL on a page customers land on.
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== INVITE_HOST) return null;

  const code = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(code)) return null;

  return `https://${INVITE_HOST}/${code}`;
}
