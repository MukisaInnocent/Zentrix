import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { checkMemberLink, videoEmbed } from '../../lib/safe-links.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireActivated, requireAuth, requireStaff } from '../auth/middleware.js';

// Videos (owner, 2026-11-03): admins add links to videos on YouTube, TikTok or any other site for members to watch.
// No files are uploaded and videos pay nothing. Links to adult content are refused. Every change is audited.
// Owner, 2026-11-05: every video plays on the site, never as an outside link. Only links to one YouTube or TikTok
// video are accepted; members get only the player address, and older links that cannot play are not shown.

interface VideoRow {
  public_id: string; title: string; description: string; link_url: string; published: boolean; sort: number;
  created_at: Date; updated_at: Date; removed_at: Date | null;
}

const COLUMNS = 'public_id, title, description, link_url, published, sort, created_at, updated_at, removed_at';

const memberView = (v: VideoRow) => {
  const { platform, embedUrl } = videoEmbed(new URL(v.link_url));
  return { id: v.public_id, title: v.title, description: v.description, platform, embedUrl };
};
const staffView = (v: VideoRow) => ({
  ...memberView(v), linkUrl: v.link_url, published: v.published, sort: v.sort, createdAt: v.created_at, updatedAt: v.updated_at, removedAt: v.removed_at,
});

// A link to one YouTube or TikTok video, which plays on the member's page.
function playableLink(raw: string): string {
  const link = safeLink(raw);
  if (!videoEmbed(new URL(link)).embedUrl) {
    const message = 'Use the link to one YouTube or TikTok video, so it plays on the site.';
    throw badRequest('validation_failed', message, { linkUrl: [message] });
  }
  return link;
}

const VideoBody = z.strictObject({
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().max(600).default(''),
  linkUrl: z.string().trim().max(500),
  published: z.boolean().default(true),
  sort: z.int().min(0).max(10000).default(0),
});
const Note = z.strictObject({ note: z.string().trim().max(300).optional() });
const Id = z.uuid();

function videoId(value: unknown): string {
  const id = Id.safeParse(value);
  if (!id.success) throw notFound();
  return id.data;
}

export function safeLink(raw: string, field = 'linkUrl'): string {
  const check = checkMemberLink(raw);
  if (!check.ok) throw badRequest('validation_failed', check.message, { [field]: [check.message] });
  return check.url.toString();
}

async function lockVideo(db: Db, id: string): Promise<VideoRow> {
  const row = await maybeOne<VideoRow>(db, `SELECT ${COLUMNS} FROM videos WHERE public_id = $1 FOR UPDATE`, [id]);
  if (!row) throw notFound();
  return row;
}

// Members with an activated account: the published videos.
export function videosRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth, requireActivated(services));
  router.get('/', async (_req, res) => {
    const list = await rows<VideoRow>(services.pool, `SELECT ${COLUMNS} FROM videos WHERE published AND removed_at IS NULL ORDER BY sort, id DESC`);
    res.json({ videos: list.map(memberView).filter(v => v.embedUrl) });
  });
  return router;
}

// Staff console. Support and admins see the list; only admins change it.
export function videosAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support'), async (req, res) => {
    const removed = req.query.removed === '1';
    const list = await rows<VideoRow>(pool, `SELECT ${COLUMNS} FROM videos WHERE ($1 OR removed_at IS NULL) ORDER BY sort, id DESC`, [removed]);
    res.json({ videos: list.map(staffView) });
  });

  router.post('/', requireStaff('admin'), async (req, res) => {
    const body = parse(VideoBody, req.body);
    const link = playableLink(body.linkUrl);
    const video = await withTransaction(pool, async db => {
      const row = await one<VideoRow>(
        db,
        `INSERT INTO videos (title, description, link_url, published, sort, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [body.title, body.description, link, body.published, body.sort, req.auth!.userId],
      );
      await audit(db, req, { action: 'video.created', targetType: 'video', targetId: row.public_id, after: staffView(row) });
      return staffView(row);
    });
    res.status(201).json({ video });
  });

  router.put('/:id', requireStaff('admin'), async (req, res) => {
    const id = videoId(req.params.id);
    const body = parse(VideoBody, req.body);
    const link = playableLink(body.linkUrl);
    const video = await withTransaction(pool, async db => {
      const before = await lockVideo(db, id);
      if (before.removed_at) throw badRequest('video.removed', 'Restore this video before editing it.');
      const row = await one<VideoRow>(
        db,
        `UPDATE videos SET title = $2, description = $3, link_url = $4, published = $5, sort = $6 WHERE public_id = $1 RETURNING ${COLUMNS}`,
        [id, body.title, body.description, link, body.published, body.sort],
      );
      await audit(db, req, { action: 'video.updated', targetType: 'video', targetId: id, before: staffView(before), after: staffView(row) });
      return staffView(row);
    });
    res.json({ video });
  });

  // Removing archives the video (members stop seeing it); restoring brings it back.
  for (const action of ['remove', 'restore'] as const) {
    router.post(`/:id/${action}`, requireStaff('admin'), async (req, res) => {
      const id = videoId(req.params.id);
      const { note } = parse(Note, req.body ?? {});
      const video = await withTransaction(pool, async db => {
        const before = await lockVideo(db, id);
        const row = await one<VideoRow>(
          db,
          `UPDATE videos SET removed_at = ${action === 'remove' ? 'coalesce(removed_at, now())' : 'NULL'} WHERE public_id = $1 RETURNING ${COLUMNS}`,
          [id],
        );
        await audit(db, req, { action: `video.${action === 'remove' ? 'removed' : 'restored'}`, targetType: 'video', targetId: id, before: staffView(before), after: staffView(row), reason: note });
        return staffView(row);
      });
      res.json({ video });
    });
  }

  return router;
}
