/**
 * Instagram, TikTok and Facebook run the page inside their own in-app
 * WKWebView/WebView and hand `window.open()` off to a *separate* process —
 * a popup opens fine, but the page's reference to it can no longer navigate
 * it afterward. Checkout's popup-tab redirect (`useStripeTabRedirect`) uses
 * this to skip the popup for these apps and send the whole tab instead.
 *
 * This list is NOT exhaustive and cannot be — it only covers the apps that
 * brand their in-app browser's user agent. WhatsApp, this store's single
 * biggest traffic source (see the root layout), does not add any marker to
 * its UA, so it cannot be detected this way; it silently hit the same
 * stuck-popup failure these patterns exist to avoid (2026-11-01). That gap is
 * exactly why `useStripeTabRedirect` also verifies the popup actually
 * navigated and falls back on its own if it didn't, instead of relying
 * solely on this list — treat this function as an optimization that skips
 * the popup attempt for *known* offenders, not as the thing that guarantees
 * correctness.
 */
export function isInAppBrowser(userAgent: string): boolean {
  return /Instagram|FBAN|FBAV|TikTok|BytedanceWebview|musical_ly/i.test(userAgent);
}
