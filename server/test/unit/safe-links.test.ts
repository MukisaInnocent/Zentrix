import { describe, expect, it } from 'vitest';
import { checkMemberLink, videoEmbed } from '../../src/lib/safe-links.js';

const ok = (raw: string) => checkMemberLink(raw).ok;

describe('member links', () => {
  it('accepts ordinary https links, including words that only contain an adult word', () => {
    expect(ok('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(ok('https://www.tiktok.com/@creator/video/7212345678901234567')).toBe(true);
    expect(ok('https://vimeo.com/123456')).toBe(true);
    expect(ok('https://www.essex.ac.uk/videos/sussex-tour')).toBe(true);
  });

  it('refuses adult sites, adult domains and adult words, and anything not https', () => {
    expect(ok('https://www.pornhub.com/view_video.php?viewkey=1')).toBe(false);
    expect(ok('https://de.xhamster.com/videos/1')).toBe(false);
    expect(ok('https://example.xxx/')).toBe(false);
    expect(ok('https://cdn.example.com/free-porn/clip.mp4')).toBe(false);
    expect(ok('https://example.com/watch?tag=NSFW')).toBe(false);
    expect(ok('https://example.com/%70orn')).toBe(false);
    expect(ok('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('not a link')).toBe(false);
  });

  it('plays YouTube and TikTok on the page and opens other sites', () => {
    const embed = (raw: string) => videoEmbed(new URL(raw));
    expect(embed('https://youtu.be/dQw4w9WgXcQ').embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(embed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1').embedUrl).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    expect(embed('https://youtube.com/shorts/abcDEF12345').embedUrl).toBe('https://www.youtube-nocookie.com/embed/abcDEF12345');
    expect(embed('https://www.tiktok.com/@creator/video/7212345678901234567').embedUrl).toBe('https://www.tiktok.com/embed/v2/7212345678901234567');
    expect(embed('https://vm.tiktok.com/ZMabc/')).toEqual({ platform: 'tiktok', embedUrl: null });
    expect(embed('https://vimeo.com/123456')).toEqual({ platform: 'other', embedUrl: null });
  });
});
