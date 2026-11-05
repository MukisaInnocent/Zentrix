import { describe, expect, it } from 'vitest';
import { countVisits, eatDay, eatDayStart, mergeDays, type LogRecord } from '../../src/providers/visits.js';

// Visitor counts for the staff Events page (owner, 2026-11-05): days run midnight to midnight East Africa Time.
const phone = 'Mozilla/5.0%20(Linux;%20Android%2014)%20Chrome/130.0';
const laptop = 'Mozilla/5.0%20(Windows%20NT%2010.0)%20Firefox/132.0';
const page = (over: Partial<LogRecord>): LogRecord => ({
  date: '2026-11-05', time: '10:00:00', 'c-ip': '196.0.0.1', 'cs-method': 'GET', 'cs-uri-stem': '/index.html', 'sc-status': '200',
  'cs(User-Agent)': phone, 'c-country': 'UG', 'sc-content-type': 'text/html', ...over,
});

describe('visit counting', () => {
  it('uses East Africa Time days', () => {
    expect(eatDay(new Date('2026-11-04T20:59:59Z'))).toBe('2026-11-04');
    expect(eatDay(new Date('2026-11-04T21:00:00Z'))).toBe('2026-11-05');
    expect(eatDayStart('2026-11-05').toISOString()).toBe('2026-11-04T21:00:00.000Z');
  });

  it('counts page views and visitors per day and country, leaving out files, the API, errors and bots', () => {
    const days = countVisits([
      page({}),
      page({ 'cs-uri-stem': '/register.html', 'sc-status': 304 }),
      page({ 'cs-uri-stem': '/', 'c-ip': '41.0.0.9', 'cs(User-Agent)': laptop, 'c-country': 'KE' }),
      page({ 'cs-uri-stem': '/css/app.css', 'sc-content-type': 'text/css' }),
      page({ 'cs-uri-stem': '/api/meta', 'sc-content-type': 'application/json' }),
      page({ 'cs-uri-stem': '/admin/index.html' }),
      page({ 'cs-uri-stem': '/nope.html', 'sc-status': '404' }),
      page({ 'cs-method': 'HEAD' }),
      page({ 'cs(User-Agent)': 'Googlebot/2.1' }),
      page({ 'cs(User-Agent)': '-' }),
      // 22:30 UTC on the 5th is the 6th in Kampala; the same phone counts again on a new day.
      page({ time: '22:30:00' }),
      page({ 'c-country': '-' , 'c-ip': '102.0.0.3' }),
    ]);
    expect(days).toEqual([
      { day: '2026-11-05', pageViews: 4, visitors: 3, countries: { UG: { pageViews: 2, visitors: 1 }, KE: { pageViews: 1, visitors: 1 }, unknown: { pageViews: 1, visitors: 1 } } },
      { day: '2026-11-06', pageViews: 1, visitors: 1, countries: { UG: { pageViews: 1, visitors: 1 } } },
    ]);
  });

  it('replaces recounted days in the stored index and keeps the others', () => {
    const now = new Date('2026-11-06T08:00:00Z');
    const old = { updatedAt: 'x', days: [{ day: '2026-11-04', pageViews: 9, visitors: 5, countries: {} }, { day: '2026-11-05', pageViews: 1, visitors: 1, countries: {} }] };
    const merged = mergeDays(old, [{ day: '2026-11-05', pageViews: 7, visitors: 3, countries: {} }, { day: '2026-11-06', pageViews: 2, visitors: 2, countries: {} }], now);
    expect(merged.days.map(d => [d.day, d.pageViews])).toEqual([['2026-11-04', 9], ['2026-11-05', 7], ['2026-11-06', 2]]);
    expect(merged.updatedAt).toBe(now.toISOString());
  });
});
