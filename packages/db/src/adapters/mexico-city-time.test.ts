import { describe, expect, it } from 'vitest';
import {
  mexicoCityCustomRange,
  mexicoCityDayRange,
  mexicoCityMonthRange,
  mexicoCityWeekRange,
  mexicoCityYesterdayRange,
} from './mexico-city-time.js';

describe('mexicoCityDayRange', () => {
  it('an order completed just after Mexico City midnight the next UTC day still lands in the earlier day', () => {
    // 2026-09-15T01:00:00Z = 2026-09-14 19:00 Mexico City (UTC-6). The bug this
    // guards against: deriving "today" from host-local Date methods (which on
    // this UTC-running stack would say Sept 15) instead of the Mexico City
    // calendar date (Sept 14).
    const completedAt = new Date('2026-09-15T01:00:00Z');
    const range = mexicoCityDayRange(completedAt);

    expect(range.start.toISOString()).toBe('2026-09-14T06:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-09-15T06:00:00.000Z');
    expect(completedAt >= range.start && completedAt < range.end).toBe(true);
  });

  it('an order completed right at Mexico City midnight starts the new day, not the old one', () => {
    // 2026-09-15T06:00:00Z = 2026-09-15 00:00:00 Mexico City exactly.
    const completedAt = new Date('2026-09-15T06:00:00Z');
    const dayOf14th = mexicoCityDayRange(new Date('2026-09-14T12:00:00Z'));
    const dayOf15th = mexicoCityDayRange(completedAt);

    expect(completedAt >= dayOf14th.end).toBe(true);
    expect(completedAt >= dayOf15th.start && completedAt < dayOf15th.end).toBe(true);
  });

  it('rolls over months and years correctly', () => {
    const range = mexicoCityDayRange(new Date('2027-01-01T03:00:00Z')); // 2026-12-31 21:00 MX
    expect(range.start.toISOString()).toBe('2026-12-31T06:00:00.000Z');
    expect(range.end.toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });
});

describe('mexicoCityYesterdayRange', () => {
  it('ends exactly where today starts', () => {
    const now = new Date('2026-09-15T01:00:00Z'); // 2026-09-14 19:00 Mexico City
    const yesterday = mexicoCityYesterdayRange(now);
    const today = mexicoCityDayRange(now);

    expect(yesterday.end.toISOString()).toBe(today.start.toISOString());
    expect(yesterday.start.toISOString()).toBe('2026-09-13T06:00:00.000Z');
  });

  it('rolls back across a month boundary', () => {
    // 2026-10-01 10:00 Mexico City — yesterday is September 30th.
    const range = mexicoCityYesterdayRange(new Date('2026-10-01T16:00:00Z'));
    expect(range.start.toISOString()).toBe('2026-09-30T06:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-01T06:00:00.000Z');
  });

  it('rolls back across a year boundary', () => {
    const range = mexicoCityYesterdayRange(new Date('2027-01-01T16:00:00Z'));
    expect(range.start.toISOString()).toBe('2026-12-31T06:00:00.000Z');
    expect(range.end.toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });
});

describe('mexicoCityWeekRange', () => {
  it('starts on Monday and ends the following Monday, regardless of which weekday is passed in', () => {
    // 2026-09-15 is a Tuesday.
    const tuesday = mexicoCityWeekRange(new Date('2026-09-15T18:00:00Z'));
    expect(tuesday.start.toISOString()).toBe('2026-09-14T06:00:00.000Z'); // Monday
    expect(tuesday.end.toISOString()).toBe('2026-09-21T06:00:00.000Z'); // next Monday

    // 2026-09-13 is a Sunday — must fall in the PRECEDING week, not the next.
    const sunday = mexicoCityWeekRange(new Date('2026-09-13T18:00:00Z'));
    expect(sunday.start.toISOString()).toBe('2026-09-07T06:00:00.000Z');
    expect(sunday.end.toISOString()).toBe('2026-09-14T06:00:00.000Z');
  });
});

describe('mexicoCityMonthRange', () => {
  it('spans the full calendar month in Mexico City time', () => {
    const range = mexicoCityMonthRange(new Date('2026-09-15T18:00:00Z'));
    expect(range.start.toISOString()).toBe('2026-09-01T06:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-01T06:00:00.000Z');
  });
});

describe('mexicoCityCustomRange', () => {
  it('treats the end date as inclusive', () => {
    const range = mexicoCityCustomRange('2026-09-01', '2026-09-05');
    expect(range.start.toISOString()).toBe('2026-09-01T06:00:00.000Z');
    // Exclusive end is the day AFTER the inclusive end date.
    expect(range.end.toISOString()).toBe('2026-09-06T06:00:00.000Z');
  });

  it('a single-day custom range matches mexicoCityDayRange for that day', () => {
    const custom = mexicoCityCustomRange('2026-09-14', '2026-09-14');
    const day = mexicoCityDayRange(new Date('2026-09-14T12:00:00Z'));
    expect(custom).toEqual(day);
  });
});
