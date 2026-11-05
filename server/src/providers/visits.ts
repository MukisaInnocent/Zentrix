import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../config/env.js';

// Site visitors for the staff Events page (owner, 2026-11-05). On AWS, CloudFront writes its access logs to S3 and the
// `visits` function (outside the VPC, no database) counts them every hour into one small summary file, which the API
// reads here; the database never wakes for a visit. A day runs midnight to midnight East Africa Time (UTC+3, no
// daylight saving). Visitors are counted per day by IP address and browser, held only in memory while counting:
// the summary holds counts, never addresses.

export const VISITS_S3_KEY = 'stats/visits/index.json';
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

const CountrySchema = z.object({ pageViews: z.number().int().min(0), visitors: z.number().int().min(0) });
const DaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pageViews: z.number().int().min(0),
  visitors: z.number().int().min(0),
  countries: z.record(z.string(), CountrySchema),
});
const IndexSchema = z.object({ updatedAt: z.string(), days: z.array(DaySchema) });
export type DayVisits = z.infer<typeof DaySchema>;
export type VisitsIndex = z.infer<typeof IndexSchema>;

export const readVisitsIndex = (json: string): VisitsIndex => IndexSchema.parse(JSON.parse(json));

// The East Africa Time calendar day of a moment, as YYYY-MM-DD.
export const eatDay = (at: Date): string => new Date(at.getTime() + EAT_OFFSET_MS).toISOString().slice(0, 10);

// The UTC moment an East Africa Time day starts.
export const eatDayStart = (day: string): Date => new Date(Date.parse(`${day}T00:00:00Z`) - EAT_OFFSET_MS);

// One line of a CloudFront standard log (v2, JSON output). Fields CloudFront could not fill hold "-".
export interface LogRecord {
  date?: string; time?: string; 'c-ip'?: string; 'cs-method'?: string; 'cs-uri-stem'?: string; 'sc-status'?: string | number;
  'cs(User-Agent)'?: string; 'c-country'?: string; 'sc-content-type'?: string;
}

const BOT = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|monitor|uptime|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|headless|lighthouse|pingdom|scan/i;

function decoded(value: string | undefined): string {
  if (!value || value === '-') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// A page someone opened: a successful GET of an HTML page, not the API, the staff console, a file or a health check.
export function isPageView(r: LogRecord): boolean {
  if (r['cs-method'] !== 'GET') return false;
  const status = Number(r['sc-status']);
  if (status !== 200 && status !== 304) return false;
  const path = r['cs-uri-stem'] ?? '';
  if (/^\/(api|admin)(\/|$)/.test(path) || path === '/healthz' || path === '/readyz') return false;
  const type = r['sc-content-type'] ?? '';
  return type.startsWith('text/html') || path.endsWith('/') || path.endsWith('.html');
}

export const isBot = (r: LogRecord): boolean => {
  const agent = decoded(r['cs(User-Agent)']);
  return agent === '' || BOT.test(agent);
};

// Counts page views and visitors per East Africa Time day, overall and per country.
export function countVisits(records: Iterable<LogRecord>): DayVisits[] {
  const days = new Map<string, { pageViews: number; visitors: Set<string>; countries: Map<string, { pageViews: number; visitors: Set<string> }> }>();
  for (const r of records) {
    if (!r.date || !r.time || !isPageView(r) || isBot(r)) continue;
    const at = new Date(`${r.date}T${r.time}Z`);
    if (Number.isNaN(at.getTime())) continue;
    const day = eatDay(at);
    const visitor = createHash('sha256').update(`${r['c-ip'] ?? ''}|${decoded(r['cs(User-Agent)'])}|${day}`).digest('base64url');
    const country = /^[A-Z]{2}$/.test(r['c-country'] ?? '') ? r['c-country']! : 'unknown';
    let d = days.get(day);
    if (!d) days.set(day, (d = { pageViews: 0, visitors: new Set(), countries: new Map() }));
    d.pageViews += 1;
    d.visitors.add(visitor);
    let c = d.countries.get(country);
    if (!c) d.countries.set(country, (c = { pageViews: 0, visitors: new Set() }));
    c.pageViews += 1;
    c.visitors.add(visitor);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({
    day, pageViews: d.pageViews, visitors: d.visitors.size,
    countries: Object.fromEntries([...d.countries.entries()].map(([cc, c]) => [cc, { pageViews: c.pageViews, visitors: c.visitors.size }])),
  }));
}

// Puts freshly counted days into the stored index, replacing those days.
export function mergeDays(index: VisitsIndex | null, fresh: DayVisits[], now: Date): VisitsIndex {
  const byDay = new Map((index?.days ?? []).map(d => [d.day, d]));
  for (const d of fresh) byDay.set(d.day, d);
  return { updatedAt: now.toISOString(), days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

export interface VisitsSource {
  index(): Promise<VisitsIndex | null>;
}

export class S3VisitsSource implements VisitsSource {
  private readonly s3 = new S3Client({});
  constructor(private readonly bucket: string) {}
  async index(): Promise<VisitsIndex | null> {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: VISITS_S3_KEY }));
      return readVisitsIndex(await object.Body!.transformToString());
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return null;
      throw err;
    }
  }
}

// Tests: a fixed index.
export class FixedVisitsSource implements VisitsSource {
  constructor(private readonly value: VisitsIndex | null) {}
  index(): Promise<VisitsIndex | null> {
    return Promise.resolve(this.value);
  }
}

// Off the AWS stack (local runs) there are no CloudFront logs, so there are no visitor counts.
export function createVisitsSource(config: Config): VisitsSource | null {
  return config.visitsS3Bucket ? new S3VisitsSource(config.visitsS3Bucket) : null;
}
