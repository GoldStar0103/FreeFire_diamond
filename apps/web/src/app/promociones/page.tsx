import type { Metadata } from 'next';
import Link from 'next/link';
import { listStorefront } from '@levelup/db';
import { getDb } from '../../lib/server';
import { diamonds } from '../../lib/format';
import { flyerUrl } from '../../lib/assets';
import { designFlyerSrc } from '../../lib/design-flyers';
import { DiamondIcon } from '../icons';
import { MascotMedia } from '../mascot-media';
import { SiteHeader } from '../site-header';
import promoStill from '../../assets/mascot/promo-still.webp';

export const metadata: Metadata = {
  title: 'Promociones',
  description: 'Todas las promociones del mes, con todos sus paquetes.',
  alternates: { canonical: '/promociones' },
};

export const dynamic = 'force-dynamic';

/** Mockup glow cycle: gold → cyan → magenta → violet (design data-glow). */
const GLOWS = ['gold', 'cyan', 'magenta', 'cyan', 'violet', 'violet'] as const;

/** Design page order + live catalog extras (descuentos / lluvia). */
const CAMPAIGN_ORDER = [
  ['mega_oferta', 'mega oferta'],
  ['mini'],
  ['descuentos', 'chidos'],
  ['dulce'],
  ['lluvia'],
  ['energia', 'insana'],
  ['super_pack', 'super pack'],
  ['mega_prime', 'megaprime', 'packs_mega'],
] as const;

type Campaign = Awaited<ReturnType<typeof listStorefront>>[number];

function sortCampaigns(campaigns: Campaign[]): Campaign[] {
  const used = new Set<string>();
  const ordered: Campaign[] = [];

  for (const needles of CAMPAIGN_ORDER) {
    const found = campaigns.find(
      (c) =>
        !used.has(c.key) &&
        needles.some((n) => c.key.includes(n.replace(' ', '_')) || c.name.toLowerCase().includes(n)),
    );
    if (found) {
      ordered.push(found);
      used.add(found.key);
    }
  }

  for (const campaign of campaigns) {
    if (!used.has(campaign.key)) ordered.push(campaign);
  }
  return ordered;
}

function priceLabel(centavos: number): string {
  return `$${(centavos / 100).toLocaleString('es-MX', {
    maximumFractionDigits: 0,
  })}`;
}

/**
 * Full promotions catalog — approved redesign `.promo` groups: framed flyer,
 * title + badge + count, then the 2-col style cards. Prices always come from
 * the server (never hardcoded).
 */
export default async function PromocionesPage() {
  const campaigns = sortCampaigns(await listStorefront(getDb()));
  const allCombos = campaigns.flatMap((c) => c.combos);
  const minPriceCents = allCombos.length > 0 ? Math.min(...allCombos.map((c) => c.priceMxnCents)) : null;

  return (
    <main className="page pr">
      <SiteHeader />

      <section className="pr-head" aria-labelledby="pr-titulo">
        <span className="pr-eyebrow">
          <i aria-hidden="true" />
          Promociones
        </span>
        <h1 id="pr-titulo">
          Promociones <em>del mes</em>
        </h1>
        <p>Todo lo que tenemos activo ahora mismo, en un solo lugar.</p>
        {(campaigns.length > 0 || minPriceCents !== null) && (
          <div className="pr-chips">
            {campaigns.length > 0 && (
              <span className="pr-chip">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M3 7l9-4 9 4-9 4z" />
                  <path d="M3 12l9 4 9-4" />
                  <path d="M3 17l9 4 9-4" />
                </svg>
                <b>{campaigns.length}</b> grupo{campaigns.length === 1 ? '' : 's'} activo
                {campaigns.length === 1 ? '' : 's'}
              </span>
            )}
            {minPriceCents !== null && (
              <span className="pr-chip">
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2l4 7 6 1-4.5 4.3L18.8 21 12 17.4 5.2 21 6.5 14.3 2 10l6-1z" />
                </svg>
                Combos desde <b>{priceLabel(minPriceCents)}</b> MXN
              </span>
            )}
          </div>
        )}
        <MascotMedia
          className="pr-head-mascot"
          webm="/mascot/mascota-promo.webm"
          animWebp="/mascot/mascota-promo-anim.webp"
          stillSrc={promoStill.src}
          alt="Luchador de LevelUp abrazando un diamante"
          ariaHidden
        />
      </section>

      {campaigns.length === 0 && (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}

      {campaigns.map((campaign, i) => {
        const flyer =
          designFlyerSrc(campaign.key, campaign.name) ?? flyerUrl(campaign.flyerAssetUrl);
        const glow = GLOWS[i % GLOWS.length];
        const oncePerId = campaign.combos.some((c) => c.maxPerPlayer != null);
        const badge =
          campaign.badge ??
          (oncePerId ? 'Solo clientes nuevos · 1 sola vez por ID' : null);

        return (
          <section key={campaign.key} className="pr-group" data-glow={glow}>
            <Link href={`/promocion/${campaign.key}`} className="pr-flyer">
              <span className="pr-flyer-frame">
                <span className="pr-flyer-shot">
                  {flyer ? (
                    <img src={flyer} alt={campaign.name} loading="lazy" decoding="async" />
                  ) : (
                    <span className="pr-flyer-empty">{campaign.name}</span>
                  )}
                </span>
                <span className="pr-flyer-shine" aria-hidden="true" />
                <span className="pr-corner tl" aria-hidden="true" />
                <span className="pr-corner tr" aria-hidden="true" />
                <span className="pr-corner bl" aria-hidden="true" />
                <span className="pr-corner br" aria-hidden="true" />
              </span>
            </Link>

            <div className="pr-row">
              <h2>
                {campaign.name}
                {badge ? <span>{badge}</span> : null}
              </h2>
              <span className="pr-line" aria-hidden="true" />
              <span className="pr-count">
                {campaign.combos.length} combo{campaign.combos.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="pr-combos">
              {campaign.combos.map((combo) => {
                const unique = combo.maxPerPlayer != null;
                return (
                  <Link
                    key={combo.key}
                    href={`/comprar/${combo.key}`}
                    className={`pr-combo${unique ? ' is-mega' : ''}`}
                  >
                    {unique && <span className="pr-combo-tag">Único</span>}
                    <span className="pr-combo-qty">
                      {diamonds(combo.advertisedDiamonds)}
                      <DiamondIcon className="icon" />
                    </span>
                    <span className="pr-combo-nm">{combo.name}</span>
                    <span className="pr-combo-pr">
                      {priceLabel(combo.priceMxnCents)} <small>MXN</small>
                    </span>
                    <span className="pr-combo-go" aria-hidden="true">
                      →
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}
