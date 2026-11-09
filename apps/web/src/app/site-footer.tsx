import Link from 'next/link';
import { legalIdentity, pending } from '../lib/legal';
import { socialLinks } from '../lib/social';
import { supportUrl } from '../lib/support';
import logo from '../assets/logo.webp';

/**
 * Site-wide footer matching the approved redesign `.foot` grid: brand blurb,
 * navigation, legal, social — then a base row with copyright + operator.
 */
export function SiteFooter() {
  const social = socialLinks();
  const year = new Date().getFullYear();
  const whatsapp = supportUrl();
  const hasSocial = Boolean(social.facebook || social.instagram || social.tiktok || whatsapp);

  return (
    <footer className="site-footer">
      <div className="foot-grid">
        <div className="foot-brand">
          <div className="foot-brand-row">
            <img src={logo.src} width={32} height={32} alt="" loading="lazy" decoding="async" />
            <b>LevelUp Store</b>
          </div>
          <p>Recargas de diamantes y monedas para tus juegos, hechas por gamers para gamers.</p>
        </div>
        <div>
          <h4>Navegación</h4>
          <ul>
            <li>
              <Link href="/">Inicio</Link>
            </li>
            <li>
              <Link href="/promociones">Promociones</Link>
            </li>
            <li>
              <Link href="/cuenta">Mi cuenta</Link>
            </li>
            <li>
              <Link href="/pedidos">Pedidos</Link>
            </li>
            <li>
              <Link href="/confianza">Confianza</Link>
            </li>
          </ul>
        </div>
        <div>
          <h4>Legal</h4>
          <ul>
            <li>
              <Link href="/legal/terminos">Términos y condiciones</Link>
            </li>
            <li>
              <Link href="/legal/privacidad">Privacidad</Link>
            </li>
            <li>
              <Link href="/confianza">Métodos de pago</Link>
            </li>
            <li>
              <Link href="/legal/terminos">Devoluciones</Link>
            </li>
          </ul>
        </div>
        {hasSocial && (
          <div>
            <h4>Síguenos</h4>
            <ul className="foot-social">
              {social.tiktok && (
                <li>
                  <a href={social.tiktok} target="_blank" rel="noreferrer">
                    TikTok
                  </a>
                </li>
              )}
              {social.instagram && (
                <li>
                  <a href={social.instagram} target="_blank" rel="noreferrer">
                    Instagram
                  </a>
                </li>
              )}
              {social.facebook && (
                <li>
                  <a href={social.facebook} target="_blank" rel="noreferrer">
                    Facebook
                  </a>
                </li>
              )}
              {whatsapp && (
                <li>
                  <a href={whatsapp} target="_blank" rel="noreferrer">
                    WhatsApp
                  </a>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
      <div className="foot-base">
        <span>© {year} LevelUp Store. Todos los derechos reservados.</span>
        <span>Operado por {pending(legalIdentity().legalName, 'razón social')}.</span>
      </div>
    </footer>
  );
}
