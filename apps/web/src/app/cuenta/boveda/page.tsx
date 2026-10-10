import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyLevelUpOverview } from '@levelup/db';
import { getCustomerSession } from '../../../lib/customer-session.js';
import { getDb } from '../../../lib/server.js';
import { diamonds, mxn } from '../../../lib/format.js';
import { CuentaForm } from '../cuenta-form';

export const metadata: Metadata = {
  title: 'La Bóveda',
  description: 'Tus precios exclusivos mientras la temporada siga abierta.',
  alternates: { canonical: '/cuenta/boveda' },
};

export const dynamic = 'force-dynamic';

function daysRemaining(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function BovedaPage() {
  const session = await getCustomerSession();

  if (!session) {
    return (
      <main className="page narrow">
        <h1 className="page-title">La Bóveda</h1>
        <p className="page-sub">Entra con tu correo para ver si ya la desbloqueaste.</p>
        <CuentaForm />
      </main>
    );
  }

  const overview = await getMyLevelUpOverview(getDb(), session.playerProfileId);

  if (!overview.season) {
    return (
      <main className="page narrow">
        <p className="hint" style={{ marginBottom: 8 }}>
          <Link href="/cuenta">← Mi cuenta</Link>
        </p>
        <h1 className="page-title">La Bóveda</h1>
        <p className="page-sub">Todavía no hay una temporada activa.</p>
      </main>
    );
  }

  const { vault, season } = overview;
  const days = vault.expiresAt ? daysRemaining(vault.expiresAt) : null;

  return (
    <main className="page narrow">
      <p className="hint" style={{ marginBottom: 8 }}>
        <Link href="/cuenta">← Mi cuenta</Link>
      </p>

      {/*
        Same honesty as the Level Pass hero: no illustrated key art exists for
        this yet (combos have no per-offer image field at all today — flyers
        are a campaign-level asset, not per-combo), so this is the same
        CSS-only treatment, not a placeholder standing in for something the
        data model can't yet provide.
      */}
      <div className={`vlt-hero${vault.unlocked ? ' unlocked' : ''}`}>
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <h1 className="page-title vlt-hero-title" style={{ marginBottom: 0 }}>
            La Bóveda
          </h1>
          <span className={`vlt-status${vault.unlocked ? ' unlocked' : ''}`}>
            {vault.unlocked ? '🔓 Desbloqueada' : '🔒 Bloqueada'}
          </span>
        </div>
        <p className="hint" style={{ marginTop: 2 }}>Temporada {season.seasonNumber}</p>

        {vault.unlocked ? (
          <>
            {days !== null && (
              <span className="season-pill unlocked-gold">
                ⏱ {days} día{days === 1 ? '' : 's'} para que cierre
              </span>
            )}
            <p className="hint" style={{ marginTop: 10 }}>
              Tus precios exclusivos están disponibles durante todo lo que reste de la temporada.
              Puedes comprarlos las veces que quieras.
            </p>
          </>
        ) : (
          <>
            <span className="season-pill locked">🔒 Completa el Level Pass</span>
            <p className="hint" style={{ marginTop: 10 }}>
              Alcanza el último checkpoint del Level Pass para desbloquear precios exclusivos en 6
              promociones, válidos hasta que cierre la temporada.
            </p>
            <Link href="/cuenta/level-pass" className="btn sm primary" style={{ marginTop: 6 }}>
              Ver mi progreso →
            </Link>
          </>
        )}
      </div>

      {vault.unlocked && (
        <>
          <h2 className="section-title">
            {/* Not a suffix swap: "promoción" -> "promociones" drops the written
                accent on pluralizing (the stress moves off the final syllable),
                same as canción -> canciones. Appending "es" to the singular
                word verbatim would render the misspelled "promociónes". */}
            Tus {vault.offers.length} {vault.offers.length === 1 ? 'promoción exclusiva' : 'promociones exclusivas'}
          </h2>

          {vault.offers.length === 0 ? (
            <div className="card empty">
              Todavía no hay ofertas configuradas para La Bóveda esta temporada.
            </div>
          ) : (
            <div className="vlt-grid">
              {vault.offers.map((o) => {
                const savingsCents = o.publicPriceMxnCents - o.vaultPriceMxnCents;
                return (
                  <div key={o.vaultOfferId} className="card vlt-offer">
                    <div className="vlt-offer-diamonds">{diamonds(o.advertisedDiamonds)} 💎</div>
                    <div className="vlt-offer-name">{o.comboName}</div>
                    <div className="vlt-offer-prices">
                      <s className="hint">{mxn(o.publicPriceMxnCents)}</s>
                      <span className="vlt-offer-price">{mxn(o.vaultPriceMxnCents)}</span>
                    </div>
                    {savingsCents > 0 && (
                      <span className="vlt-savings">Ahorras {mxn(savingsCents)}</span>
                    )}
                    <Link
                      href={`/comprar/${o.comboKey}?oferta=${o.vaultOfferId}`}
                      className="btn sm primary vlt-offer-cta"
                    >
                      Comprar
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </main>
  );
}
