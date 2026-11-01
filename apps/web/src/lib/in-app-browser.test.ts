import { describe, expect, it } from 'vitest';
import { isInAppBrowser } from './in-app-browser.js';

const INSTAGRAM_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 309.0.0.41.111 (iPhone14,5; iOS 17_4; en_US; en-US; scale=2.00; 1170x2532; 498464485)';

const FACEBOOK_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/459.0.0.36.109;FBBV/597572111;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBSS/3;FBID/phone;FBLC/en_US]';

const FACEBOOK_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/459.0.0.0.0;]';

const TIKTOK_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 musical_ly_2023121001 BytedanceWebview/d8a21c6';

const PLAIN_CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';

// WhatsApp's in-app browser does not add any marker to the user agent — this
// is exactly the gap that let a WhatsApp customer hit the stuck-popup bug on
// 2026-11-01 after Instagram/TikTok/Facebook were already covered. This case
// documents that the gap is real and expected, not an oversight to "fix" by
// adding a string here (there is none to add) — `useStripeTabRedirect`'s own
// stuck-popup fallback is what actually covers this browser.
const WHATSAPP_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36';

describe('isInAppBrowser', () => {
  it.each([
    ['Instagram (iOS)', INSTAGRAM_IOS],
    ['Facebook (iOS, FBAN/FBAV)', FACEBOOK_IOS],
    ['Facebook (Android, FBAV)', FACEBOOK_ANDROID],
    ['TikTok (Android)', TIKTOK_ANDROID],
  ])('detects %s', (_label, ua) => {
    expect(isInAppBrowser(ua)).toBe(true);
  });

  it('does not flag a plain mobile browser', () => {
    expect(isInAppBrowser(PLAIN_CHROME_ANDROID)).toBe(false);
  });

  it('cannot detect WhatsApp (undetectable by user agent — see file comment)', () => {
    expect(isInAppBrowser(WHATSAPP_ANDROID)).toBe(false);
  });
});
