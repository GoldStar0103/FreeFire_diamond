/**
 * Season close: freeze the ranking, award season badges, open the next
 * season. Runs from the worker's sweep loop, same "survive and log" slot as
 * `alertStuckGatewayPayments` — see runner.ts.
 *
 * `planSeasonClose` is pure (one season's due data in, one write plan out),
 * tested without any store at all. `closeDueSeasons` is the thin sweep loop:
 * find what's due, plan each one, hand the plan to the store to apply
 * atomically. The store is responsible for doing all of "insert Hall of Fame
 * rows, award badges, expire this season's vault entitlements, close this
 * season, open the next one" as one transaction — a season must never be
 * left half-closed if the process dies partway through.
 *
 * Badge assignment here only covers the *ranking* tier (Season Champion / Top
 * 3 / Top 10 / Top 50). The Level Pass Completed badge is awarded the moment
 * a player crosses the final checkpoint — see level-pass.ts's
 * `vaultUnlocked` — because that happens whenever it happens during the
 * season, not only for players who are still active right at close.
 */

export interface DueSeason {
  id: string;
  seasonNumber: number;
  endsAt: Date;
}

export interface SeasonRankingRow {
  playerProfileId: string;
  displayName: string | null;
  avatarAssetUrl: string | null;
  seasonalDiamonds: number;
}

export interface HallOfFamePlan {
  position: number;
  playerProfileId: string;
  displayNameSnapshot: string | null;
  avatarAssetUrlSnapshot: string | null;
  seasonalDiamonds: number;
}

export interface BadgeAwardPlan {
  playerProfileId: string;
  badgeKey: string;
  achievementData: { finalPosition: number };
}

export interface SeasonClosePlan {
  seasonId: string;
  hallOfFame: HallOfFamePlan[];
  badgeAwards: BadgeAwardPlan[];
  nextSeasonNumber: number;
  nextSeasonStartsAt: Date;
  nextSeasonEndsAt: Date;
}

/**
 * Only the Top 3 freeze into the Hall of Fame (per spec); everyone in the
 * supplied ranking still gets a badge award if they qualify for one. By
 * default a player gets only their single highest-tier badge for the season
 * — not Top 50 *and* Top 10 *and* Top 3 simultaneously — matching the spec's
 * stated default, which it also calls out as something to make configurable
 * later if LevelUp wants cumulative badges instead.
 */
export function rankingBadgeKey(position: number): string | null {
  if (position === 1) return 'season_champion';
  if (position <= 3) return 'top_3';
  if (position <= 10) return 'top_10';
  if (position <= 50) return 'top_50';
  return null;
}

const addDays = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);

/** `ranking` must already be sorted descending by seasonalDiamonds. */
export function planSeasonClose(
  due: DueSeason,
  ranking: SeasonRankingRow[],
  now: Date,
  seasonLengthDays = 60,
): SeasonClosePlan {
  const hallOfFame: HallOfFamePlan[] = ranking.slice(0, 3).map((row, i) => ({
    position: i + 1,
    playerProfileId: row.playerProfileId,
    displayNameSnapshot: row.displayName,
    avatarAssetUrlSnapshot: row.avatarAssetUrl,
    seasonalDiamonds: row.seasonalDiamonds,
  }));

  const badgeAwards: BadgeAwardPlan[] = [];
  ranking.forEach((row, index) => {
    const position = index + 1;
    const badgeKey = rankingBadgeKey(position);
    if (badgeKey) {
      badgeAwards.push({ playerProfileId: row.playerProfileId, badgeKey, achievementData: { finalPosition: position } });
    }
  });

  return {
    seasonId: due.id,
    hallOfFame,
    badgeAwards,
    nextSeasonNumber: due.seasonNumber + 1,
    nextSeasonStartsAt: now,
    nextSeasonEndsAt: addDays(now, seasonLengthDays),
  };
}

export interface SeasonStore {
  /** Active seasons whose endsAt has already passed, as of `now`. */
  findDueSeasons(now: Date): Promise<DueSeason[]>;
  /** The full current-season ranking, already sorted descending — Top 50 and badge tiers both read from it. */
  getSeasonRanking(seasonId: string): Promise<SeasonRankingRow[]>;
  /**
   * Apply the plan atomically: insert Hall of Fame rows, award ranking
   * badges (skipping any a player already holds for this season — a
   * re-run after a crash must not double-award), expire this season's
   * vault entitlements, mark the season closed, and create the next one.
   */
  closeSeason(plan: SeasonClosePlan): Promise<void>;
}

export interface SeasonDeps {
  store: SeasonStore;
  seasonLengthDays?: number;
  now?: () => Date;
}

export interface SeasonCloseResult {
  closed: string[];
  failed: number;
}

export async function closeDueSeasons(deps: SeasonDeps): Promise<SeasonCloseResult> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.store.findDueSeasons(now);

  const closed: string[] = [];
  let failed = 0;

  for (const season of due) {
    try {
      const ranking = await deps.store.getSeasonRanking(season.id);
      const plan = planSeasonClose(season, ranking, now, deps.seasonLengthDays);
      await deps.store.closeSeason(plan);
      closed.push(season.id);
    } catch (err) {
      failed++;
      console.error(`[seasons] Could not close season ${season.seasonNumber}: ${String(err)}`);
    }
  }

  return { closed, failed };
}
