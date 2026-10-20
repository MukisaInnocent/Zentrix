import { Router } from 'express';
import { rows } from '../../db/sql.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { getSetting } from '../settings/registry.js';
import { countryOpen, currentCountryConfig, listCountries } from './service.js';

// Public reference data for sign-up and formatting. Money values are strings in minor units; the browser
// formats them with Intl.NumberFormat and the currency exponent (section 1).
export function referenceRouter(services: Services): Router {
  const { pool, config } = services;
  const router = Router();

  router.get('/countries', async (_req, res) => {
    const countries = (await listCountries(pool)).filter(c => countryOpen(c, config.appMode));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      countries: countries.map(c => ({
        code: c.code, name: c.name, currency: c.currencyCode, dialCode: c.dialCode, timezone: c.defaultTimezone,
      })),
    });
  });

  router.get('/currencies', async (_req, res) => {
    const list = await rows<{ code: string; name: string; exponent: number }>(
      pool, 'SELECT code, name, exponent FROM currencies WHERE enabled ORDER BY code',
    );
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ currencies: list });
  });

  router.get('/config/:country', async (req, res) => {
    const code = String(req.params.country).toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw notFound();
    const c = await currentCountryConfig(pool, code);
    if (!c) throw notFound('config.not_found', 'This country is not configured yet.');
    res.json({
      config: {
        country: c.countryCode, currency: c.currencyCode, version: c.version, isPlaceholder: c.isPlaceholder,
        membershipFee: { amountMinor: c.membershipFeeMinor, currency: c.currencyCode },
        withdrawal: {
          feeBasisPoints: c.withdrawalFeeBp,
          minimum: { amountMinor: c.withdrawalMinMinor, currency: c.currencyCode },
          maximum: { amountMinor: c.withdrawalMaxMinor, currency: c.currencyCode },
          dailyMaximum: { amountMinor: c.withdrawalDailyMaxMinor, currency: c.currencyCode },
          monthlyMaximum: { amountMinor: c.withdrawalMonthlyMaxMinor, currency: c.currencyCode },
          approvalThreshold: { amountMinor: c.withdrawalApprovalThresholdMinor, currency: c.currencyCode },
        },
        termsVersion: c.termsVersion,
        privacyVersion: c.privacyVersion,
      },
    });
  });

  return router;
}

export function metaRouter(services: Services): Router {
  const router = Router();
  router.get('/', async (_req, res) => {
    res.json({
      appMode: services.config.appMode,
      testMode: services.config.appMode === 'test',
      support: await getSetting(services.pool, 'support.contact'),
      communityUrl: await getSetting(services.pool, 'community.url'),
    });
  });
  return router;
}
