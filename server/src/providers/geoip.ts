import type { Request } from 'express';
import type { Config } from '../config/env.js';

// Country of the request's IP, used only to flag mismatches for review (section 1). A real GeoIP
// database is a TODO(owner); test mode can simulate it with a header.
export interface GeoIp {
  countryOf(req: Request): string | null;
}

export const noGeoIp: GeoIp = { countryOf: () => null };

export const testHeaderGeoIp: GeoIp = {
  countryOf(req) {
    const value = req.get('x-test-geo-country');
    return value && /^[A-Z]{2}$/.test(value) ? value : null;
  },
};

export function createGeoIp(config: Config): GeoIp {
  if (config.geoipProvider === 'test-header') {
    if (config.appMode !== 'test') throw new Error('GEOIP_PROVIDER=test-header is only allowed in test mode.');
    return testHeaderGeoIp;
  }
  return noGeoIp;
}
