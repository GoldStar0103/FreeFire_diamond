import { describe, expect, it, vi } from 'vitest';
import {
  closeDueSeasons,
  planSeasonClose,
  rankingBadgeKey,
  type DueSeason,
  type SeasonRankingRow,
  type SeasonStore,
} from './seasons.js';

describe('rankingBadgeKey', () => {
  it.each<[number, string | null]>([
    [1, 'season_champion'],
    [2, 'top_3'],
    [3, 'top_3'],
    [4, 'top_10'],
    [10, 'top_10'],
    [11, 'top_50'],
    [50, 'top_50'],
    [51, null],
  ])('maps position %i to %s', (position, expected) => {
    expect(rankingBadgeKey(position)).toBe(expected);
  });
});

const row = (n: number, diamonds: number): SeasonRankingRow => ({
  playerProfileId: `profile-${n}`,
  displayName: `Player${n}`,
  avatarAssetUrl: null,
  seasonalDiamonds: diamonds,
});

const DUE: DueSeason = { id: 'season-1', seasonNumber: 3, endsAt: new Date('2026-11-01') };

describe('planSeasonClose', () => {
  it('freezes only the top 3 into the Hall of Fame, in position order', () => {
    const ranking = [row(1, 10_000), row(2, 8_000), row(3, 5_000), row(4, 1_000)];
    const plan = planSeasonClose(DUE, ranking, new Date('2026-11-02'));

    expect(plan.hallOfFame).toEqual([
      { position: 1, playerProfileId: 'profile-1', displayNameSnapshot: 'Player1', avatarAssetUrlSnapshot: null, seasonalDiamonds: 10_000 },
      { position: 2, playerProfileId: 'profile-2', displayNameSnapshot: 'Player2', avatarAssetUrlSnapshot: null, seasonalDiamonds: 8_000 },
      { position: 3, playerProfileId: 'profile-3', displayNameSnapshot: 'Player3', avatarAssetUrlSnapshot: null, seasonalDiamonds: 5_000 },
    ]);
  });

  it('awards exactly one ranking badge per qualifying player, the highest tier they reached', () => {
    const ranking = Array.from({ length: 51 }, (_, i) => row(i + 1, 1_000 - i));
    const plan = planSeasonClose(DUE, ranking, new Date('2026-11-02'));

    expect(plan.badgeAwards).toHaveLength(50); // positions 1-50 qualify, 51st does not
    expect(plan.badgeAwards[0]).toEqual({
      playerProfileId: 'profile-1',
      badgeKey: 'season_champion',
      achievementData: { finalPosition: 1 },
    });
    expect(plan.badgeAwards.find((b) => b.playerProfileId === 'profile-11')).toEqual({
      playerProfileId: 'profile-11',
      badgeKey: 'top_50',
      achievementData: { finalPosition: 11 },
    });
    expect(plan.badgeAwards.find((b) => b.playerProfileId === 'profile-51')).toBeUndefined();
  });

  it('carries no Hall of Fame or badges when nobody ranked this season', () => {
    const plan = planSeasonClose(DUE, [], new Date('2026-11-02'));
    expect(plan.hallOfFame).toEqual([]);
    expect(plan.badgeAwards).toEqual([]);
  });

  it('numbers and dates the next season from "now", defaulting to a 60-day length', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const plan = planSeasonClose(DUE, [], now);

    expect(plan.nextSeasonNumber).toBe(4);
    expect(plan.nextSeasonStartsAt).toEqual(now);
    expect(plan.nextSeasonEndsAt).toEqual(new Date('2027-01-01T00:00:00Z')); // 60 days after Nov 2
  });

  it('honours a configured season length other than 60 days', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const plan = planSeasonClose(DUE, [], now, 30);
    expect(plan.nextSeasonEndsAt).toEqual(new Date('2026-12-02T00:00:00Z'));
  });
});

function harness(due: DueSeason[], ranking: SeasonRankingRow[] = []) {
  const store: SeasonStore = {
    findDueSeasons: vi.fn(async () => due),
    getSeasonRanking: vi.fn(async () => ranking),
    closeSeason: vi.fn(async () => undefined),
  };
  return { store };
}

describe('closeDueSeasons', () => {
  it('does nothing when no season is due', async () => {
    const { store } = harness([]);
    const result = await closeDueSeasons({ store });

    expect(result).toEqual({ closed: [], failed: 0 });
    expect(store.closeSeason).not.toHaveBeenCalled();
  });

  it('closes a single due season with its plan', async () => {
    const { store } = harness([DUE], [row(1, 500)]);
    const result = await closeDueSeasons({ store, now: () => new Date('2026-11-02') });

    expect(result).toEqual({ closed: ['season-1'], failed: 0 });
    expect(store.closeSeason).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: 'season-1', nextSeasonNumber: 4 }),
    );
  });

  it('keeps going and reports the failure when one season fails to close', async () => {
    const seasonA: DueSeason = { id: 'season-a', seasonNumber: 1, endsAt: new Date('2026-11-01') };
    const seasonB: DueSeason = { id: 'season-b', seasonNumber: 5, endsAt: new Date('2026-11-01') };
    const store: SeasonStore = {
      findDueSeasons: vi.fn(async () => [seasonA, seasonB]),
      getSeasonRanking: vi.fn(async () => []),
      closeSeason: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce(undefined),
    };

    const result = await closeDueSeasons({ store });

    expect(result).toEqual({ closed: ['season-b'], failed: 1 });
    expect(store.closeSeason).toHaveBeenCalledTimes(2);
  });

  it('closes more than one due season in the same sweep', async () => {
    const seasonA: DueSeason = { id: 'season-a', seasonNumber: 1, endsAt: new Date('2026-11-01') };
    const seasonB: DueSeason = { id: 'season-b', seasonNumber: 2, endsAt: new Date('2026-11-01') };
    const { store } = harness([seasonA, seasonB]);

    const result = await closeDueSeasons({ store });
    expect(result).toEqual({ closed: ['season-a', 'season-b'], failed: 0 });
  });
});
