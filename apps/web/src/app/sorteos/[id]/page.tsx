import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getGiveawayPublic, getMyEntry, getMyProfile, listGiveawayLeaderboard } from '@levelup/db';
import { getDb } from '../../../lib/server';
import { getCustomerSession } from '../../../lib/customer-session';
import { SiteHeader } from '../../site-header';
import { ParticiparSorteo } from './participar-sorteo';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const giveaway = await getGiveawayPublic(getDb(), id);
  return {
    title: giveaway?.title ?? 'Sorteo',
    alternates: { canonical: `/sorteos/${id}` },
  };
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Abierto',
  closed_pending_draw: 'Cerrado — esperando sorteo',
  drawn: 'Sorteado',
  delivered: 'Premio entregado',
  cancelled: 'Cancelado',
};

/**
 * Viewable at every stage of a giveaway's life, not just while open —
 * `getGiveawayPublic` doesn't 404 once it closes/draws/cancels, so the
 * entry-progress/leaderboard/winner/cancellation info stays visible. Like
 * `/ranking`, this page itself needs no login; only the entry form does
 * (ticket balance is account-tied), gated at `enterGiveawayAction` already.
 */
export default async function SorteoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const [giveaway, session, leaderboard] = await Promise.all([
    getGiveawayPublic(db, id),
    getCustomerSession(),
    listGiveawayLeaderboard(db, id),
  ]);
  if (!giveaway) notFound();

  const now = Date.now();
  const isOpenNow = giveaway.status === 'open' && now >= giveaway.opensAt.getTime() && now < giveaway.closesAt.getTime();

  const [profile, myEntry] = await Promise.all([
    session ? getMyProfile(db, session.playerProfileId) : null,
    session ? getMyEntry(db, id, session.playerProfileId) : null,
  ]);

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
          <span className="v">
            {giveaway.totalEntryCount}
            {giveaway.maxParticipants != null
              ? ` · ${giveaway.totalEntrants}/${giveaway.maxParticipants} participantes`
              : ''}
          </span>
        </div>
        <div className="fila">
          <span className="k">Estado</span>
          <span className="v">{STATUS_LABEL[giveaway.status] ?? giveaway.status}</span>
        </div>
        {session && profile && (
          <div className="fila">
            <span className="k">Tus tickets</span>
            <span className="v">{profile.ticketBalance}</span>
          </div>
        )}
      </div>

      {giveaway.status === 'cancelled' && (
        <div className="alert bad">
          Este sorteo se canceló{giveaway.cancelReason ? `: ${giveaway.cancelReason}` : ''}. Se devolvieron los
          tickets a quienes participaron.
        </div>
      )}

      {(giveaway.status === 'drawn' || giveaway.status === 'delivered') && (
        <div className="alert ok">
          🎉 Ganador: <b>{giveaway.winnerDisplayName ?? 'Jugador de LevelUp'}</b>
          {giveaway.status === 'delivered' ? ' — premio entregado.' : ' — premio en camino.'}
        </div>
      )}

      {giveaway.status === 'closed_pending_draw' && (
        <div className="alert warn">Este sorteo ya cerró y está esperando el sorteo del ganador.</div>
      )}

      {isOpenNow && session && (
        <ParticiparSorteo
          giveawayId={giveaway.id}
          entryCostTickets={giveaway.entryCostTickets}
          ticketBalance={profile?.ticketBalance ?? 0}
          myEntryCount={myEntry?.entryCount ?? 0}
          maxEntriesPerPlayer={giveaway.maxEntriesPerPlayer}
        />
      )}

      {isOpenNow && !session && (
        <div className="card">
          <p className="hint" style={{ marginTop: 0 }}>
            <Link href="/cuenta">Inicia sesión en Mi LevelUp</Link> para participar con tus Golden Tickets.
          </p>
        </div>
      )}

      {leaderboard.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Quién va ganando</h2>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            {leaderboard.map((row) => (
              <li key={row.playerProfileId}>
                {row.displayName} — {row.entryCount} entrada{row.entryCount === 1 ? '' : 's'}
              </li>
            ))}
          </ol>
        </div>
      )}
    </main>
  );
}
