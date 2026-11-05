import { Router } from 'express';
import { z } from 'zod';
import { one, rows } from '../../db/sql.js';
import { parse } from '../../http/validate.js';
import { eatDay, eatDayStart, type DayVisits } from '../../providers/visits.js';
import type { Services } from '../../services.js';
import { requireStaff } from '../auth/middleware.js';

// Events (owner, 2026-11-05): how many people visit the site and how many members register and activate, per day and
// overall, by country. Days run midnight to midnight East Africa Time. Registrations and activations come from the
// database; visitors come from the CloudFront log counts the visits function leaves in S3 (AWS only), so a visit never
// wakes the database. Staff and system (zx_) accounts are left out.

const Query = z.strictObject({ days: z.coerce.number().int().min(7).max(366).default(30) });

const MEMBER = `u.username NOT LIKE 'zx\\_%'
  AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.name = ur.role WHERE ur.user_id = u.id AND ro.is_staff)`;

interface DayCount { day: string; country: string; n: string }

export function eventsAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support', 'compliance', 'finance'), async (req, res) => {
    const { days } = parse(Query, req.query);
    const today = eatDay(services.now());
    const dayList = Array.from({ length: days }, (_, i) => eatDay(new Date(eatDayStart(today).getTime() - i * 86_400_000)));
    const from = eatDayStart(dayList[dayList.length - 1]!);

    const [registered, activated, totals, names, index] = await Promise.all([
      rows<DayCount>(
        pool,
        `SELECT to_char(u.created_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD') AS day, u.country_code AS country, count(*) AS n
         FROM users u WHERE u.created_at >= $1 AND ${MEMBER} GROUP BY 1, 2`,
        [from],
      ),
      rows<DayCount>(
        pool,
        `SELECT to_char(m.activated_at AT TIME ZONE 'Africa/Kampala', 'YYYY-MM-DD') AS day, u.country_code AS country, count(*) AS n
         FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.activated_at >= $1 AND ${MEMBER} GROUP BY 1, 2`,
        [from],
      ),
      one<{ registrations: string; activations: string }>(
        pool,
        `SELECT count(*) AS registrations, count(m.user_id) AS activations FROM users u LEFT JOIN memberships m ON m.user_id = u.id WHERE ${MEMBER}`,
      ),
      rows<{ code: string; name: string }>(pool, 'SELECT code, name FROM countries'),
      services.visits ? services.visits.index().catch((err: unknown) => {
        services.logger.warn({ err }, 'visitor counts could not be read');
        return null;
      }) : Promise.resolve(null),
    ]);

    const visitsByDay = new Map<string, DayVisits>((index?.days ?? []).map(d => [d.day, d]));
    const inPeriod = new Set(dayList);
    const sumBy = (list: DayCount[], day: string) => list.filter(r => r.day === day).reduce((n, r) => n + Number(r.n), 0);
    const daily = dayList.map(day => {
      const v = visitsByDay.get(day);
      return { day, registrations: sumBy(registered, day), activations: sumBy(activated, day), visitors: v?.visitors ?? null, pageViews: v?.pageViews ?? null };
    });

    const countries = new Map<string, { registrations: number; activations: number; visitors: number; pageViews: number }>();
    const entry = (cc: string) => {
      let c = countries.get(cc);
      if (!c) countries.set(cc, (c = { registrations: 0, activations: 0, visitors: 0, pageViews: 0 }));
      return c;
    };
    for (const r of registered) entry(r.country).registrations += Number(r.n);
    for (const r of activated) entry(r.country).activations += Number(r.n);
    for (const d of index?.days ?? []) {
      if (!inPeriod.has(d.day)) continue;
      for (const [cc, v] of Object.entries(d.countries)) {
        entry(cc).visitors += v.visitors;
        entry(cc).pageViews += v.pageViews;
      }
    }
    const nameOf = new Map(names.map(n => [n.code, n.name]));
    const sum = (key: 'registrations' | 'activations' | 'visitors' | 'pageViews') => daily.reduce((n, d) => n + (d[key] ?? 0), 0);

    res.json({
      today, days,
      totals: { registrations: Number(totals.registrations), activations: Number(totals.activations) },
      period: { registrations: sum('registrations'), activations: sum('activations'), visitors: sum('visitors'), pageViews: sum('pageViews') },
      daily,
      countries: [...countries.entries()]
        .map(([code, c]) => ({ code, name: code === 'unknown' ? 'Unknown' : nameOf.get(code) ?? code, ...c }))
        .sort((a, b) => b.visitors - a.visitors || b.registrations - a.registrations || a.name.localeCompare(b.name)),
      visits: {
        available: index !== null,
        updatedAt: index?.updatedAt ?? null,
        since: index?.days[0]?.day ?? null,
        allTime: { visitors: (index?.days ?? []).reduce((n, d) => n + d.visitors, 0), pageViews: (index?.days ?? []).reduce((n, d) => n + d.pageViews, 0) },
      },
    });
  });

  return router;
}
