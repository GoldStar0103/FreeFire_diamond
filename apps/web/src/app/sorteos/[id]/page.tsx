import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMyEntry, getMyProfile, getOpenGiveaway } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { requireCustomerSession } from '../../../lib/customer-session';
import { SiteHeader } from '../../site-header';
import { ParticiparSorteo } from './participar-sorteo';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const giveaway = await getOpenGiveaway(getDb(), id);
  return {
    title: giveaway?.title ?? 'Sorteo',
    alternates: { canonical: `/sorteos/${id}` },
  };
}

export default async function SorteoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Ticket balance belongs to the logged-in account, so entering requires one — no guest path.
  const session = await requireCustomerSession();

  const db = getDb();
  const [giveaway, profile, myEntry] = await Promise.all([
    getOpenGiveaway(db, id),
    getMyProfile(db, session.playerProfileId),
    getMyEntry(db, id, session.playerProfileId),
  ]);

  if (!giveaway || !profile) notFound();

  return (
    <main className="page narrow">
      <SiteHeader />

      <section className="pr-head" aria-labelledby="sorteo-titulo">
        <span className="pr-eyebrow">
          <i aria-hidden="true" />
          Sorteo
        </span>
        <h1 id="sorteo-titulo">{giveaway.title}</h1>
        <p>{giveaway.description}</p>
      </section>

      <div className="card">
        <div className="fila">
          <span className="k">Premio</span>
          <span className="v">{giveaway.prizeDescription}</span>
        </div>
        <div className="fila">
          <span className="k">Costo por entrada</span>
          <span className="v">{giveaway.entryCostTickets} tickets</span>
        </div>
        <div className="fila">
          <span className="k">Entradas hasta ahora</span>
          <span className="v">{giveaway.totalEntryCount}</span>
        </div>
        <div className="fila">
          <span className="k">Tus tickets</span>
          <span className="v">{profile.ticketBalance}</span>
        </div>
      </div>

      <ParticiparSorteo
        giveawayId={giveaway.id}
        entryCostTickets={giveaway.entryCostTickets}
        ticketBalance={profile.ticketBalance}
        myEntryCount={myEntry?.entryCount ?? 0}
      />
    </main>
  );
}
