import type { Metadata } from 'next';
import Link from 'next/link';
import { listStorefront } from '@levelup/db';
import { getCustomerSession } from '../lib/customer-session';
import { getDb } from '../lib/server';
import { socialLinks } from '../lib/social';
import paintedHome from '../assets/home/painted-home.png';
import { BoltIcon, HeadsetIcon, InfinityIcon, ShieldIcon } from './icons';
import { HowItWorks } from './how-it-works';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { alternates: { canonical: '/' } };

const WHY_US = [
  {
    icon: BoltIcon,
    tone: 'purple',
    title: 'Recargas automáticas',
    text: 'Diamantes directo a tu cuenta. Sin esperar, sin complicaciones.',
  },
  {
    icon: ShieldIcon,
    tone: 'cyan',
    title: 'Pago 100% seguro',
    text: 'Métodos de pago confiables. Tu compra protegida.',
  },
  {
    icon: InfinityIcon,
    tone: 'green',
    title: 'Garantía de por vida',
    text: 'Nuestros diamantes son libres de baneo o reembolso.',
  },
  {
    icon: HeadsetIcon,
    tone: 'pink',
    title: 'Soporte LevelUp',
    text: 'Estamos contigo antes y después de tu recarga.',
  },
] as const;

const FLYER_SLOTS = [
  ['descuentos', 'chidos'],
  ['super_pack', 'super pack'],
  ['energia', 'insana'],
  ['mega_prime', 'megaprime', 'packs_mega'],
] as const;

type Campaign = Awaited<ReturnType<typeof listStorefront>>[number];

function assignFlyerSlots(campaigns: Campaign[], featuredKey: string | null): (Campaign | null)[] {
  const rest = campaigns.filter((c) => c.key !== featuredKey);
  const used = new Set<string>();
  const slots: (Campaign | null)[] = [null, null, null, null];

  FLYER_SLOTS.forEach((needles, i) => {
    const found = rest.find(
      (c) =>
        !used.has(c.key) &&
        needles.some((n) => c.key.includes(n.replace(' ', '_')) || c.name.toLowerCase().includes(n)),
    );
    if (found) {
      slots[i] = found;
      used.add(found.key);
    }
  });

  for (const campaign of rest) {
    const empty = slots.indexOf(null);
    if (empty === -1) break;
    if (!used.has(campaign.key)) {
      slots[empty] = campaign;
      used.add(campaign.key);
    }
  }

  return slots;
}

export default async function HomePage() {
  const [campaigns, session] = await Promise.all([
    listStorefront(getDb()),
    getCustomerSession(),
  ]);

  const packs = campaigns.flatMap((campaign) => campaign.combos.map((combo) => ({ campaign, combo })));
  const featured =
    packs.find((p) => p.combo.advertisedDiamonds === 110) ??
    packs.find((p) => p.campaign.permanent) ??
    packs[0] ??
    null;

  const social = socialLinks();
  const flyers = assignFlyerSlots(campaigns, featured?.campaign.key ?? null);
  const buyHref = featured ? `/comprar/${featured.combo.key}` : '/promociones';

  return (
    <main className="page hm hm-painted">
      <h1 className="sr-only">LevelUp Store — Recargas Free Fire</h1>
      <div className="hm-board">
        <img className="hm-board-art" src={paintedHome.src} alt="LevelUp Store" decoding="async" />

        {social.tiktok && (
          <a
            className="hm-hit"
            style={{ left: '2.4%', top: '5.2%', width: '8.2%', height: '3.6%' }}
            href={social.tiktok}
            target="_blank"
            rel="noreferrer"
            aria-label="TikTok"
          />
        )}
        {social.instagram && (
          <a
            className="hm-hit"
            style={{ left: '10.6%', top: '5.2%', width: '8.2%', height: '3.6%' }}
            href={social.instagram}
            target="_blank"
            rel="noreferrer"
            aria-label="Instagram"
          />
        )}
        <Link
          className="hm-hit"
          style={{ left: '86.2%', top: '4.6%', width: '11.4%', height: '4.4%' }}
          href="/cuenta"
          aria-label={session ? 'Mi cuenta' : 'Crear mi cuenta'}
        />
        <Link
          className="hm-hit"
          style={{ left: '1.6%', top: '9.4%', width: '96.8%', height: '4.4%' }}
          href="/ranking"
          aria-label="Ver tabla de Temporada 1"
        />
        <Link
          className="hm-hit"
          style={{ left: '1.6%', top: '14.2%', width: '96.8%', height: '26.2%' }}
          href={buyHref}
          aria-label="Comprar 110 diamantes"
        />
        <Link
          className="hm-hit"
          style={{ left: '1.6%', top: '41.2%', width: '96.8%', height: '10.4%' }}
          href="/promociones"
          aria-label="Ver ofertas"
        />
        <Link
          className="hm-hit"
          style={{ left: '70%', top: '56.4%', width: '28.4%', height: '3.6%' }}
          href="/promociones"
          aria-label="Ver más ofertas"
        />
        {flyers.map((campaign, i) => {
          const col = i % 2;
          const row = Math.floor(i / 2);
          const href = campaign ? `/promocion/${campaign.key}` : '/promociones';
          return (
            <Link
              key={campaign?.key ?? `slot-${i}`}
              className="hm-hit"
              style={{
                left: col === 0 ? '1.6%' : '50.6%',
                top: row === 0 ? '60.4%' : '75.6%',
                width: '47.8%',
                height: '14.8%',
              }}
              href={href}
              aria-label={campaign ? campaign.name : 'Ver promociones'}
            />
          );
        })}
        <Link
          className="hm-hit"
          style={{ left: '0%', top: '91.8%', width: '20%', height: '8%' }}
          href="/"
          aria-label="Inicio"
        />
        <Link
          className="hm-hit"
          style={{ left: '20%', top: '91.8%', width: '20%', height: '8%' }}
          href="/promociones"
          aria-label="Promociones"
        />
        <Link
          className="hm-hit"
          style={{ left: '40%', top: '91.8%', width: '20%', height: '8%' }}
          href="/cuenta"
          aria-label="Mi cuenta"
        />
        <Link
          className="hm-hit"
          style={{ left: '60%', top: '91.8%', width: '20%', height: '8%' }}
          href="/confianza"
          aria-label="Confianza"
        />
        <Link
          className="hm-hit"
          style={{ left: '80%', top: '91.8%', width: '20%', height: '8%' }}
          href="/soporte"
          aria-label="Soporte"
        />
      </div>

      {campaigns.length === 0 && (
        <div className="card empty">Estamos preparando las promociones del mes. Vuelve pronto.</div>
      )}

      <section>
        <h2 className="section-title-lg center">
          ¿Por qué elegir <span className="grad">LevelUp Store</span>?
        </h2>
        <div className="why-grid">
          {WHY_US.map(({ icon: Icon, tone, title, text }) => (
            <div key={title} className={`card why-item glow-${tone}`}>
              <div className={`trust-icon ${tone}`}>
                <Icon className="icon" />
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <HowItWorks />
    </main>
  );
}
