import Link from 'next/link';
import { getCustomerSession } from '../lib/customer-session';
import { socialLinks } from '../lib/social';
import logo from '../assets/logo.webp';
import { BellIcon, FacebookIcon, InstagramIcon, TikTokIcon, UserIcon } from './icons';
import { HmBar } from './hm-bar';

/**
 * Sticky top bar (social · brand · bell/account) matching the approved
 * redesign header — wordmark center, account actions right. TikTok /
 * Instagram / Facebook chips on the left only on the homepage (`showSocial`).
 * Pass `fadeOnScroll` on the homepage so the bar dissolves while browsing
 * and only returns at the very top.
 */
export async function SiteHeader({
  fadeOnScroll = false,
  showSocial = false,
}: {
  fadeOnScroll?: boolean;
  showSocial?: boolean;
} = {}) {
  const social = showSocial ? socialLinks() : null;
  const session = await getCustomerSession();

  return (
    <HmBar fadeOnScroll={fadeOnScroll}>
      <div className="hm-bar-in">
        <div className="hm-bar-side hm-bar-social">
          {social && (
            <div className="social-links">
              {social.tiktok && (
                <a href={social.tiktok} target="_blank" rel="noreferrer" aria-label="TikTok">
                  <TikTokIcon className="icon" />
                </a>
              )}
              {social.instagram && (
                <a href={social.instagram} target="_blank" rel="noreferrer" aria-label="Instagram">
                  <InstagramIcon className="icon" />
                </a>
              )}
              {social.facebook && (
                <a href={social.facebook} target="_blank" rel="noreferrer" aria-label="Facebook">
                  <FacebookIcon className="icon" />
                </a>
              )}
            </div>
          )}
        </div>
        <Link href="/" className="hm-bar-brand">
          <img src={logo.src} width={34} height={34} alt="" decoding="async" />
          <span className="hm-bar-wordmark">
            LEVELUP
            <i>STORE MÉXICO</i>
          </span>
        </Link>
        <div className="hm-bar-side hm-bar-account">
          <span className="hm-bar-user hm-bar-bell" aria-hidden="true">
            <BellIcon className="icon" />
            <span className="hm-bar-bell-dot">2</span>
          </span>
          <Link
            href="/cuenta"
            className="hm-bar-user"
            aria-label={session ? 'Mi cuenta' : 'Crear mi cuenta'}
          >
            <UserIcon className="icon" />
          </Link>
        </div>
      </div>
    </HmBar>
  );
}
