import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireAuth, requireStaff } from '../auth/middleware.js';

// E-books (owner, 2026-11-01): admins add, edit, hide and remove the books on the member E-books page. Each book has
// a section (grouping on the page), a title, a description, an optional page count and a link to its file. Every
// change writes the audit log.

interface EbookRow {
  public_id: string; section: string; title: string; description: string; pages: number | null; link_url: string;
  published: boolean; sort: number; created_at: Date; updated_at: Date; removed_at: Date | null;
}

const view = (b: EbookRow) => ({
  id: b.public_id, section: b.section, title: b.title, description: b.description, pages: b.pages, linkUrl: b.link_url,
  published: b.published, sort: b.sort, createdAt: b.created_at, updatedAt: b.updated_at, removedAt: b.removed_at,
});

const SELECT = 'SELECT public_id, section, title, description, pages, link_url, published, sort, created_at, updated_at, removed_at FROM ebooks';

const EbookBody = z.strictObject({
  section: z.string().trim().min(2, { error: 'Name the section, for example Marketing.' }).max(60),
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(600),
  pages: z.int().min(1).max(5000).nullable().optional(),
  linkUrl: z.url({ protocol: /^https$/, error: 'Use a full https:// link to the book file.' }).max(500),
  published: z.boolean().default(true),
  sort: z.int().min(0).max(10000).default(0),
});
const Note = z.strictObject({ note: z.string().trim().max(300).optional() });
const Id = z.uuid();

function bookId(value: unknown): string {
  const id = Id.safeParse(value);
  if (!id.success) throw notFound();
  return id.data;
}

async function lockBook(db: Db, id: string): Promise<EbookRow> {
  const row = await maybeOne<EbookRow>(db, `${SELECT} WHERE public_id = $1 FOR UPDATE`, [id]);
  if (!row) throw notFound();
  return row;
}

// Members: the published books, by section.
export function ebooksRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);
  router.get('/', async (_req, res) => {
    const list = await rows<EbookRow>(services.pool, `${SELECT} WHERE published AND removed_at IS NULL ORDER BY section, sort, id`);
    res.json({ ebooks: list.map(b => ({ id: b.public_id, section: b.section, title: b.title, description: b.description, pages: b.pages, linkUrl: b.link_url })) });
  });
  return router;
}

// Staff console. Support and admins see the list; only admins change it.
export function ebooksAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support'), async (req, res) => {
    const removed = req.query.removed === '1';
    const list = await rows<EbookRow>(pool, `${SELECT} WHERE ($1 OR removed_at IS NULL) ORDER BY section, sort, id`, [removed]);
    res.json({ ebooks: list.map(view) });
  });

  router.post('/', requireStaff('admin'), async (req, res) => {
    const body = parse(EbookBody, req.body);
    const book = await withTransaction(pool, async db => {
      const row = await one<EbookRow>(
        db,
        `INSERT INTO ebooks (section, title, description, pages, link_url, published, sort, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING public_id, section, title, description, pages, link_url, published, sort, created_at, updated_at, removed_at`,
        [body.section, body.title, body.description, body.pages ?? null, body.linkUrl, body.published, body.sort, req.auth!.userId],
      );
      await audit(db, req, { action: 'ebook.created', targetType: 'ebook', targetId: row.public_id, after: view(row) });
      return view(row);
    });
    res.status(201).json({ ebook: book });
  });

  router.put('/:id', requireStaff('admin'), async (req, res) => {
    const id = bookId(req.params.id);
    const body = parse(EbookBody, req.body);
    const book = await withTransaction(pool, async db => {
      const before = await lockBook(db, id);
      if (before.removed_at) throw badRequest('ebook.removed', 'Restore this book before editing it.');
      const row = await one<EbookRow>(
        db,
        `UPDATE ebooks SET section = $2, title = $3, description = $4, pages = $5, link_url = $6, published = $7, sort = $8 WHERE public_id = $1
         RETURNING public_id, section, title, description, pages, link_url, published, sort, created_at, updated_at, removed_at`,
        [id, body.section, body.title, body.description, body.pages ?? null, body.linkUrl, body.published, body.sort],
      );
      await audit(db, req, { action: 'ebook.updated', targetType: 'ebook', targetId: id, before: view(before), after: view(row) });
      return view(row);
    });
    res.json({ ebook: book });
  });

  // Removing archives the book (members stop seeing it); restoring brings it back.
  for (const action of ['remove', 'restore'] as const) {
    router.post(`/:id/${action}`, requireStaff('admin'), async (req, res) => {
      const id = bookId(req.params.id);
      const { note } = parse(Note, req.body ?? {});
      const book = await withTransaction(pool, async db => {
        const before = await lockBook(db, id);
        const row = await one<EbookRow>(
          db,
          `UPDATE ebooks SET removed_at = ${action === 'remove' ? 'coalesce(removed_at, now())' : 'NULL'} WHERE public_id = $1
           RETURNING public_id, section, title, description, pages, link_url, published, sort, created_at, updated_at, removed_at`,
          [id],
        );
        await audit(db, req, { action: `ebook.${action === 'remove' ? 'removed' : 'restored'}`, targetType: 'ebook', targetId: id, before: view(before), after: view(row), reason: note });
        return view(row);
      });
      res.json({ ebook: book });
    });
  }

  return router;
}
