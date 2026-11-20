import type { Metadata } from 'next';
import Link from 'next/link';
import { getMyProfile, listOpenGiveaways } from '@levelup/db';
import { getDb } from '../../lib/server';
import { getCustomerSession } from '../../lib/customer-session';
import { SiteHeader } from '../site-header';

export const metadata: Metadata = {
  title: 'Sorteos',
  description: 'Sorteos con premios reales, pagados con tus Golden Tickets.',
  alternates: { canonical: '/sorteos' },
};

export const dynamic = 'force-dynamic';

const SCHEDULE_LABEL: Record<'daily' | 'weekly' | 'monthly' | 'flash', string> = {
  daily: 'Sorteo diario',
  weekly: 'Sorteo semanal',
  monthly: 'Sorteo mensual',
  flash: 'Sorteo flash',
};

function timeRemaining(closesAt: Date): string {
  const ms = closesAt.getTime() - Date.now();
  if (ms <= 0) return 'Cerrando…';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min restantes`;
  if (hours < 24) return `${hours} h restantes`;
  return `${Math.floor(hours / 24)} día${Math.floor(hours / 24) === 1 ? '' : 's'} restantes`;
}

export default async function SorteosPage() {
  const db = getDb();
  const session = await getCustomerSession();
  const [giveaways, profile] = await Promise.all([
    listOpenGiveaways(db),
    session ? getMyProfile(db, session.playerProfileId) : null,
  ]);

  return (
    <main className="page pr">
      <SiteHeader />

      <section className="pr-head" aria-labelledby="sorteos-titulo">
        <span className="pr-eyebrow">
          <i aria-hidden="true" />
          Sorteos
        </span>
        <h1 id="sorteos-titulo">
          Gana premios <em>con tus Golden Tickets</em>
        </h1>
        <p>
          Ganas Golden Tickets automáticamente con cada recarga que te entregamos — úsalos para
          participar aquí, sin gastar dinero extra.
        </p>
        {session && profile && (
          <p className="pr-chip" style={{ display: 'inline-flex' }}>
            Tienes <b>{profile.ticketBalance}</b> tickets
          </p>
        )}
        {!session && (
          <p className="hint">
            <Link href="/cuenta">Inicia sesión en Mi LevelUp</Link> para ver tus tickets y participar.
          </p>
        )}
      </section>

      {giveaways.length === 0 ? (
        <div className="card empty">Todavía no hay sorteos abiertos. Vuelve pronto.</div>
      ) : (
        <div className="art-grid">
          {giveaways.map((g) => (
            <Link key={g.id} href={`/sorteos/${g.id}`} className="card art-card">
              <span className="art-card-kind">{SCHEDULE_LABEL[g.scheduleType]}</span>
              <span className="art-card-name">{g.title}</span>
              <span className="art-card-price">{g.prizeDescription}</span>
              <span className="art-card-stock">
                {g.entryCostTickets} ticket{g.entryCostTickets === 1 ? '' : 's'} por entrada ·{' '}
                {g.totalEntryCount} entrada{g.totalEntryCount === 1 ? '' : 's'} hasta ahora
              </span>
              <span className="art-card-cta">{timeRemaining(g.closesAt)} · Participar →</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
