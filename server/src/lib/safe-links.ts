// Links staff add for members (tasks and videos, owner 2026-11-03): https only, and never to adult content. The check
// looks at the address only, so it is a guard against mistakes and obvious adult sites, not a full content filter.

// Known adult sites, matched as the whole host or any subdomain of it.
const ADULT_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com', 'spankbang.com',
  'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com', 'livejasmin.com', 'cam4.com',
  'brazzers.com', 'eporner.com', 'tnaflix.com', 'porntrex.com', 'hqporner.com', 'motherless.com', 'rule34.xxx',
  'nhentai.net', 'hentaihaven.xxx', 'erome.com', 'manyvids.com', 'clips4sale.com', 'beeg.com', 'txxx.com', 'xxxbunker.com',
];
// Top-level domains made for adult sites.
const ADULT_TLDS = ['xxx', 'porn', 'sex', 'adult'];
// Whole words in the host or path (split on anything that is not a letter or digit), so "essex" or "sussex" pass.
const ADULT_WORDS = new Set([
  'porn', 'porno', 'pornhub', 'xxx', 'sex', 'sexy', 'nsfw', 'hentai', 'nude', 'nudes', 'naked', 'erotic', 'erotica',
  'xvideos', 'xnxx', 'xhamster', 'onlyfans', 'camgirl', 'camgirls', 'milf', 'fetish', 'bdsm', 'hardcore', 'blowjob', 'nudity',
]);

export type LinkCheck = { ok: true; url: URL } | { ok: false; message: string };

export function checkMemberLink(raw: string): LinkCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: 'Enter a full link starting with https://.' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'Use an https:// link.' };
  if (url.username || url.password) return { ok: false, message: 'Links with a user name or password are not allowed.' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const blocked = { ok: false as const, message: 'Links to adult content are not allowed.' };
  if (ADULT_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) return blocked;
  if (ADULT_TLDS.includes(host.split('.').pop() ?? '')) return blocked;
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  const words = `${host} ${path} ${url.search}`.toLowerCase().split(/[^a-z0-9]+/);
  if (words.some(w => ADULT_WORDS.has(w))) return blocked;
  return { ok: true, url };
}

// Where a video link points, for showing it on the member Videos page. Only YouTube and TikTok are played on the
// page (their own embed players); every other link opens on its own site.
export type VideoPlatform = 'youtube' | 'tiktok' | 'other';

// A TikTok LIVE link (https://www.tiktok.com/@name/live). TikTok offers no player for lives on other sites, so
// these open on TikTok (owner, 2026-11-06), unlike videos, which play on the page.
export function isTiktokLive(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  return (host === 'tiktok.com' || host.endsWith('.tiktok.com')) && /^\/@[A-Za-z0-9._]{1,40}\/live\/?$/.test(url.pathname);
}

// A TikTok short link from the app's Share button (vt.tiktok.com/..., vm.tiktok.com/... or tiktok.com/t/...). Finding the
// video behind it needs a request to TikTok, which the server cannot make (no internet from the private network), so
// these open on TikTok like a LIVE (owner, 2026-11-08). A full video link still plays on the member's page.
export function isTiktokShort(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') return /^\/[A-Za-z0-9]{5,20}\/?$/.test(url.pathname);
  return host === 'tiktok.com' && /^\/t\/[A-Za-z0-9]{5,20}\/?$/.test(url.pathname);
}

// A TikTok link that opens on TikTok instead of playing on the page: a LIVE or a short link.
export const opensOnTiktok = (url: URL) => isTiktokLive(url) || isTiktokShort(url);

export function videoEmbed(url: URL): { platform: VideoPlatform; embedUrl: string | null } {
  const host = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const id = host === 'youtu.be'
      ? url.pathname.slice(1).split('/')[0]
      : url.searchParams.get('v') ?? /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(url.pathname)?.[1];
    return { platform: 'youtube', embedUrl: id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const id = /\/video\/(\d{8,25})/.exec(url.pathname)?.[1];
    return { platform: 'tiktok', embedUrl: id ? `https://www.tiktok.com/embed/v2/${id}` : null };
  }
  return { platform: 'other', embedUrl: null };
}
