import type { Metadata } from 'next';
import Link from 'next/link';
import { listStorefront } from '@levelup/db';
import { getDb } from '../../lib/server';
import { BoltIcon, HeadsetIcon, KeyIcon, ShieldIcon } from '../icons';
import { MascotMedia } from '../mascot-media';
import { SiteHeader } from '../site-header';
import { ReviewsCarousel } from './reviews-carousel';
import confianzaStill from '../../assets/mascot/confianza-still.webp';

export const metadata: Metadata = {
  title: 'Confianza',
  description: 'Cómo trabaja LevelUp Store: entrega al instante, pagos seguros y lo que dicen sus clientes.',
  alternates: { canonical: '/confianza' },
};

export const dynamic = 'force-dynamic';

/** Design-sample testimonials from confianza.html (rev. P3). */
const SAMPLE_REVIEWS = [
  {
    author: 'Irvin Salas',
    initials: 'IS',
    rating: 5,
    quote:
      'Mi compa level nunca falla, llevo meses con el y más aún con esta nueva etapa con la nueva web. 100% recomendado',
    tag: 'Pack Súper Prime',
  },
  {
    author: 'Juanpa',
    initials: 'J',
    rating: 5,
    quote: 'Mis diamantes llegaron al instante!! Todo chido la verdad',
  },
  {
    author: 'LGANG Gugy',
    initials: 'LG',
    rating: 5,
    quote:
      'Probé la oferta de $15 pesos y todo chido llegó rápido después compré la de 3000 mil diamantes y llegó igual rápido, lo recomiendo todo correcto',
    tag: '3000 diamantes · Lluvia de diamantes',
  },
  {
    author: 'Hugo FO',
    initials: 'HF',
    rating: 5,
    quote: 'Todo chido con mi papi levelup 🫡 dense sin miedo',
  },
  {
    author: 'Andrés Pal.',
    initials: 'AP',
    rating: 5,
    quote: 'Llegó todo bien, los recomendaré 👌🏻',
    tag: 'Pack huesito · 1160 diamantes',
  },
  {
    author: 'INS iZasop',
    initials: 'II',
    rating: 5,
    quote: 'Confiable y su atención al cliente muy amable. La verdad lo recomiendo, es súper chido level',
    tag: '18300 diamantes · Mega Packs',
  },
  {
    author: 'Pepoyaas',
    initials: 'P',
    rating: 4,
    quote:
      'Había comprado una recarga y me tardó en llegar una media hora aproximadamente. Si llegan, pero esa vez sí tardó la recarga',
    tag: '8600 diamantes · Pack Insano',
  },
  {
    author: 'Alexis GTR',
    initials: 'AG',
    rating: 5,
    quote: 'Ricos Dimas para mi cuenta, gracias level como siempre 🫡',
    tag: '6160 diamantes · Oferta relámpago',
  },
  {
    author: 'Jesús Nájera',
    initials: 'JN',
    rating: 5,
    quote:
      'Gran página para recargar, la verdad 👌🏻 tenía miedo la primera vez que compré pero ya llevo meses con ellos y nunca me han fallado',
  },
  {
    author: 'Santana',
    initials: 'S',
    rating: 5,
    quote: 'Los conocí en Facebook y de ahí no me he despegado de ellos, son muy buenos sus precios 🫡',
    tag: 'Pack huesito · 1160 diamantes',
  },
] as const;

const REVIEW_COUNT_LABEL = 21;

function Stars({ rating }: { rating: number }) {
  return (
    <div className="cf-stars" aria-label={`${rating} de 5 estrellas`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? '' : 'off'} aria-hidden="true">
          ★
        </span>
      ))}
    </div>
  );
}

export default async function TrustPage() {
  const campaigns = await listStorefront(getDb());
  const trustCombo =
    campaigns.flatMap((c) => c.combos).find((c) => c.advertisedDiamonds === 110) ?? null;
  const offerHref = trustCombo ? `/comprar/${trustCombo.key}` : '/promociones';
  const offerPrice = trustCombo
    ? `$${(trustCombo.priceMxnCents / 100).toLocaleString('es-MX')}`
    : '$15';

  return (
    <main className="page cf">
      <SiteHeader />

      <section className="cf-head" aria-labelledby="cf-titulo">
        <span className="cf-eyebrow">
          <i aria-hidden="true" />
          Confianza
        </span>
        <h1 id="cf-titulo">
          Tu confianza es <em>nuestro nivel</em>
        </h1>
        <p>Sabemos que comprar diamantes en internet da desconfianza. Así trabajamos.</p>
        <MascotMedia
          className="cf-head-mascot"
          webm="/mascot/confianza-luchador.webm"
          animWebp="/mascot/confianza-luchador-anim.webp"
          stillSrc={confianzaStill.src}
          alt="Luchador de LevelUp con audífonos, guiñando el ojo y con los pulgares arriba"
        />
      </section>

      <div className="cf-stats-row" role="list" aria-label="Números de la tienda">
        <div className="cf-counter" role="listitem">
          <span className="cf-counter-dot" aria-hidden="true" />
          <b>3,432</b>
          <span>
            recargas
            <br />
            entregadas
          </span>
        </div>
        <div className="cf-counter" role="listitem">
          <b>1,429</b>
          <span>
            jugadores
            <br />
            confían
          </span>
        </div>
        <div className="cf-counter" role="listitem">
          <b>4.8/5</b>
          <span>
            {REVIEW_COUNT_LABEL}
            <br />
            reseñas
          </span>
        </div>
      </div>

      <div className="cf-trust-grid">
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <BoltIcon className="icon" />
          </span>
          <h3>Entrega al instante</h3>
          <p>
            En cuanto validamos tu pago, el sistema hace la recarga solo — no dependes de que
            alguien esté despierto para atenderte.
          </p>
        </article>
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <ShieldIcon className="icon" />
          </span>
          <h3>Pagos seguros</h3>
          <p>
            Escribes tu ID y te mostramos el nombre de tu personaje antes de cobrarte. Si no eres
            tú, no pagas — así nadie recarga a la cuenta equivocada.
          </p>
        </article>
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <KeyIcon className="icon" />
          </span>
          <h3>Sin contraseñas</h3>
          <p>
            La recarga entra directo a tu cuenta con tu ID de jugador. No necesitamos — ni
            queremos — tus datos de acceso a Free Fire.
          </p>
        </article>
        <article className="cf-trust">
          <span className="cf-trust-ic" aria-hidden="true">
            <HeadsetIcon className="icon" />
          </span>
          <h3>Soporte real 24/7</h3>
          <p>
            Cada compra tiene su número de seguimiento y un equipo de soporte listo para ayudarte
            si algo no sale como esperabas.
          </p>
        </article>
      </div>

      <div className="cf-titulo-bloque">
        <h2>Lo que dicen nuestros clientes</h2>
        <span className="cf-line" aria-hidden="true" />
        <span className="cf-count">{REVIEW_COUNT_LABEL} reseñas</span>
      </div>
      <ReviewsCarousel count={SAMPLE_REVIEWS.length}>
        {SAMPLE_REVIEWS.map((t) => (
          <article className="cf-rev" key={t.author}>
            <div className="cf-rev-top">
              <span className="cf-rev-av" aria-hidden="true">
                {t.initials}
              </span>
              <div className="cf-rev-who">
                <b>{t.author}</b>
                <Stars rating={t.rating} />
              </div>
            </div>
            <blockquote>&ldquo;{t.quote}&rdquo;</blockquote>
            {'tag' in t && t.tag ? <span className="cf-rev-tag">{t.tag}</span> : null}
          </article>
        ))}
      </ReviewsCarousel>

      <section className="cf-primera">
        <h2>¿Primera vez?</h2>
        <p>
          Prueba con la oferta de confianza: 110 diamantes x {offerPrice}. Es la forma más barata de
          comprobar que somos reales, y por eso la tenemos.
        </p>
        <Link href={offerHref} className="cf-primera-btn">
          Ver la oferta
          <span aria-hidden="true">→</span>
        </Link>
      </section>
    </main>
  );
}
