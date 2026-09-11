'use client';

import Script from 'next/script';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * TikTok's standard base code, loaded after the page is interactive so it
 * never competes with the checkout for a phone's bandwidth. Most of the
 * store's traffic comes from TikTok, which is why this exists at all.
 *
 * `pixelId` is checked to be uppercase letters and digits by the server before
 * it gets here (lib/pixel-ids.ts) — it is interpolated into an inline script,
 * and a configuration value must never be able to become code.
 */
export function TikTokPixel({ pixelId }: { pixelId: string }) {
  const pathname = usePathname();
  const first = useRef(true);

  // The base code reports the page once, on the hard load. App Router
  // navigations after that are client-side and would otherwise go unreported.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.ttq?.page();
  }, [pathname]);

  return (
    <Script id="tiktok-pixel" strategy="afterInteractive">
      {`!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track",
"identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie",
"holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){
t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)
ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;
n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){
var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],
ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};
n=d.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;
e=d.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};
ttq.load('${pixelId}');ttq.page();}(window,document,'ttq');`}
    </Script>
  );
}
