import { describe, expect, it } from 'vitest';
import { appVersion, port, tz } from '../../src/config/settings.ts';
import {
  addDays,
  dayBounds,
  dayCount,
  daysInRange,
  formatClock,
  isValidDay,
  localDay,
  localHour,
  makeLocalizer,
  offsetAt,
  rangeBounds,
  today,
  weekdayMonday0,
} from '../../src/metrics/time.ts';
import { rng } from './storeHelpers.ts';

const HOUR = 3_600_000;
const NY = 'America/New_York';

describe('D26 local day and hour', () => {
  it('puts 2026-10-26T18:30:00Z on local day 2026-10-27 in Asia/Dhaka', () => {
    const ts = Date.parse('2026-10-26T18:30:00Z');
    expect(localDay(ts, 'Asia/Dhaka')).toBe('2026-10-27');
    expect(localHour(ts, 'Asia/Dhaka')).toBe(0);
    expect(localDay(ts, 'UTC')).toBe('2026-10-26');
    expect(localHour(ts, 'UTC')).toBe(18);
    expect(localDay(ts, NY)).toBe('2026-10-26');
    expect(localHour(ts, NY)).toBe(14);
  });

  it('keeps midnight as hour 0, never 24', () => {
    expect(localHour(Date.parse('2026-01-01T00:00:00Z'), 'UTC')).toBe(0);
    expect(localHour(Date.parse('2026-01-01T05:00:00Z'), NY)).toBe(0);
    expect(localHour(Date.parse('2026-01-01T05:59:59.999Z'), NY)).toBe(0);
  });

  it('handles half hour and 45 minute zones', () => {
    const ts = Date.parse('2026-10-26T18:30:00Z');
    expect(localDay(ts, 'Asia/Kolkata')).toBe('2026-10-27');
    expect(localHour(ts, 'Asia/Kolkata')).toBe(0);
    expect(localHour(Date.parse('2026-10-26T18:14:59Z'), 'Asia/Kathmandu')).toBe(23);
    expect(localHour(Date.parse('2026-10-26T18:15:00Z'), 'Asia/Kathmandu')).toBe(0);
    expect(offsetAt(ts, 'Asia/Dhaka')).toBe(6 * HOUR);
  });

  it('formats a clock time in the zone', () => {
    expect(formatClock(Date.parse('2026-10-27T09:30:05Z'), 'Asia/Dhaka')).toBe('15:30:05');
    expect(formatClock(Date.parse('2026-10-27T09:30:05Z'), 'UTC')).toBe('09:30:05');
  });
});

describe('D27 daylight saving', () => {
  it('has a 25 hour day when the clocks go back and a 23 hour day when they go forward', () => {
    const len = (d: string, z = NY) => {
      const [s, e] = dayBounds(d, z);
      return (e - s) / HOUR;
    };
    expect(len('2026-11-01')).toBe(25);
    expect(len('2026-10-31')).toBe(24);
    expect(len('2026-11-02')).toBe(24);
    expect(len('2026-03-08')).toBe(23);
    expect(len('2026-03-07')).toBe(24);
    expect(len('2026-10-04', 'Australia/Lord_Howe')).toBe(23.5);
    expect(len('2026-04-05', 'Australia/Lord_Howe')).toBe(24.5);
  });

  it('starts 2026-11-01 at 04:00Z (still EDT) and ends it at 2026-11-02T05:00Z', () => {
    const [s, e] = dayBounds('2026-11-01', NY);
    expect(new Date(s).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(new Date(e).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('has no missing and no doubled hour: every UTC hour of the three days belongs to exactly one local day', () => {
    const start = dayBounds('2026-10-31', NY)[0];
    const end = dayBounds('2026-11-02', NY)[1];
    const perDay = new Map<string, number>();
    for (let ts = start; ts < end; ts += HOUR) perDay.set(localDay(ts, NY), (perDay.get(localDay(ts, NY)) ?? 0) + 1);
    expect([...perDay.entries()]).toEqual([
      ['2026-10-31', 24],
      ['2026-11-01', 25],
      ['2026-11-02', 24],
    ]);
    // Consecutive days meet exactly: no gap and no overlap.
    expect(dayBounds('2026-10-31', NY)[1]).toBe(dayBounds('2026-11-01', NY)[0]);
    expect(dayBounds('2026-11-01', NY)[1]).toBe(dayBounds('2026-11-02', NY)[0]);
    // The repeated wall clock hour 1 appears twice on that day and the hour sequence has no hole.
    const hoursSeen: number[] = [];
    const [s1, e1] = dayBounds('2026-11-01', NY);
    for (let ts = s1; ts < e1; ts += HOUR) hoursSeen.push(localHour(ts, NY));
    expect(hoursSeen).toEqual([0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it('counts the calendar days of a range across the change', () => {
    expect(dayCount('2026-10-31', '2026-11-02')).toBe(3);
    expect(daysInRange('2026-10-30', '2026-11-03')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    expect(dayCount('2026-11-02', '2026-10-31')).toBe(0);
    expect(daysInRange('2026-11-02', '2026-10-31')).toEqual([]);
  });

  it('covers a range with one interval', () => {
    const [s, e] = rangeBounds('2026-10-31', '2026-11-02', NY);
    expect(s).toBe(dayBounds('2026-10-31', NY)[0]);
    expect(e).toBe(dayBounds('2026-11-02', NY)[1]);
  });
});

const ZONES = [
  'UTC',
  NY,
  'Asia/Dhaka',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'America/Sao_Paulo',
  'America/Havana',
  'Australia/Lord_Howe',
  'Australia/Sydney',
  'Pacific/Chatham',
  'Pacific/Apia',
  'Pacific/Kiritimati',
  'Europe/London',
  'Asia/Tehran',
  'Africa/Cairo',
  'Asia/Beirut',
];

describe('day bounds partition time in every zone', () => {
  it('contains each sampled instant in exactly the day it is labelled with, for a whole year and for odd years', () => {
    for (const z of ZONES) {
      for (const year of [2026, 2018, 2011]) {
        const from = Date.UTC(year, 0, 1) - 2 * HOUR;
        const to = Date.UTC(year + 1, 0, 1) + 2 * HOUR;
        for (let ts = from; ts < to; ts += 97 * 60_000) {
          const d = localDay(ts, z);
          const [s, e] = dayBounds(d, z);
          if (!(s <= ts && ts < e)) throw new Error(`${z} ${new Date(ts).toISOString()} ${d} [${new Date(s).toISOString()}, ${new Date(e).toISOString()})`);
        }
      }
    }
  });

  it('chains days: the end of one day is the start of the next', () => {
    for (const z of ZONES) {
      let d = '2026-01-01';
      for (let i = 0; i < 400; i++) {
        const next = addDays(d, 1);
        expect(dayBounds(d, z)[1]).toBe(dayBounds(next, z)[0]);
        d = next;
      }
    }
  });

  it('handles midnight transitions: Sao Paulo 2018 and Havana', () => {
    const len = (d: string, z: string) => (dayBounds(d, z)[1] - dayBounds(d, z)[0]) / HOUR;
    expect(len('2018-11-04', 'America/Sao_Paulo')).toBe(23); // midnight was skipped
    expect(len('2018-02-17', 'America/Sao_Paulo')).toBe(25);
    expect(len('2026-03-08', 'America/Havana')).toBe(23);
  });

  it('gives an empty interval for a day a zone skipped (Samoa, 2011-12-30)', () => {
    const [s, e] = dayBounds('2011-12-30', 'Pacific/Apia');
    expect(e - s).toBe(0);
    expect(dayBounds('2011-12-31', 'Pacific/Apia')[0]).toBe(s);
  });
});

describe('the bulk localizer equals the exact functions', () => {
  it('agrees on random instants in many zones across a year', () => {
    const rand = rng(11);
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2027, 0, 1);
    for (const z of ZONES) {
      const loc = makeLocalizer(z, from, to);
      for (let i = 0; i < 4000; i++) {
        const ts = Math.floor(from + rand() * (to - from));
        if (loc.day(ts) !== localDay(ts, z) || loc.hour(ts) !== localHour(ts, z)) throw new Error(`${z} ${new Date(ts).toISOString()}`);
      }
    }
  });

  it('agrees right at the transition seconds and outside its window', () => {
    const loc = makeLocalizer(NY, Date.UTC(2026, 10, 1, 0), Date.UTC(2026, 10, 1, 12));
    const edge = Date.parse('2026-11-01T06:00:00Z'); // 2:00 EDT becomes 1:00 EST
    for (const ts of [edge - 1, edge, edge + 1, edge - 3_600_000, edge + 3_600_000]) {
      expect(loc.hour(ts)).toBe(localHour(ts, NY));
      expect(loc.day(ts)).toBe(localDay(ts, NY));
    }
    expect(loc.day(Date.UTC(2020, 5, 5))).toBe(localDay(Date.UTC(2020, 5, 5), NY));
    expect(makeLocalizer('UTC', 5, 5).day(5)).toBe('1970-01-01');
  });
});

describe('calendar helpers', () => {
  it('adds days across month ends and leap days', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-10-27', 0)).toBe('2026-10-27');
  });

  it('gives Monday as 0', () => {
    expect(weekdayMonday0('2026-10-26')).toBe(0);
    expect(weekdayMonday0('2026-10-27')).toBe(1);
    expect(weekdayMonday0('2026-11-01')).toBe(6);
    expect(weekdayMonday0('1969-12-29')).toBe(0);
  });

  it('validates dates', () => {
    expect(isValidDay('2026-10-27')).toBe(true);
    expect(isValidDay('2026-02-29')).toBe(false);
    expect(isValidDay('2028-02-29')).toBe(true);
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('2026-1-1')).toBe(false);
    expect(isValidDay('tomorrow')).toBe(false);
  });

  it('tells today in the zone', () => {
    const now = Date.parse('2026-10-26T20:00:00Z');
    expect(today('Asia/Dhaka', now)).toBe('2026-10-27');
    expect(today('UTC', now)).toBe('2026-10-26');
  });
});

describe('settings', () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) saved[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it('uses LEDGER_TZ when set and the system zone otherwise', () => {
    withEnv({ LEDGER_TZ: 'America/New_York' }, () => expect(tz()).toBe('America/New_York'));
    withEnv({ LEDGER_TZ: undefined }, () => expect(tz()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone));
    withEnv({ LEDGER_TZ: '  ' }, () => expect(tz()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone));
  });

  it('rejects an unknown zone with a clear message', () => {
    withEnv({ LEDGER_TZ: 'Mars/Olympus' }, () => expect(() => tz()).toThrow(/Mars\/Olympus.*not valid/));
  });

  it('reads the port, default 47821', () => {
    withEnv({ LEDGER_PORT: undefined }, () => expect(port()).toBe(47821));
    withEnv({ LEDGER_PORT: '5000' }, () => expect(port()).toBe(5000));
    withEnv({ LEDGER_PORT: 'abc' }, () => expect(() => port()).toThrow(/LEDGER_PORT/));
    withEnv({ LEDGER_PORT: '70000' }, () => expect(() => port()).toThrow(/LEDGER_PORT/));
    withEnv({ LEDGER_PORT: '0' }, () => expect(() => port()).toThrow(/LEDGER_PORT/));
  });

  it('reads the version from package.json', () => {
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
