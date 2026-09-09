/**
 * Post-deploy smoke test.
 *
 *   node scripts/smoke.mjs https://levelupstore.mx https://panel.levelupstore.mx
 *
 * Exits 0 if the deployment is serving correctly, 1 otherwise. Safe to run
 * against production: every request is a GET, nothing is written, and no
 * credentials are needed.
 *
 * The runbook used to describe this as prose — "curl these, check that" — which
 * on deploy day is a checklist somebody skims at midnight. Most of what it
 * checks are failures this project has actually shipped or nearly shipped:
 *
 *   - legal pages rendering "[PENDIENTE: RFC]" because a static prerender
 *     froze the identity at build time
 *   - flyers 404ing because a storage key was rendered as a URL
 *   - the comprobante path being reachable from the public internet
 *   - a sitemap advertising a domain the site is not served on
 *
 * Each of those was invisible from the outside until someone looked at exactly
 * the right thing. This looks at exactly the right things.
 */

const [storeUrl, panelUrl] = process.argv.slice(2);

if (!storeUrl) {
  console.error('Usage: node scripts/smoke.mjs <store-url> [panel-url]');
  process.exit(2);
}

const origin = (url) => url.replace(/\/+$/, '');
const STORE = origin(storeUrl);
const PANEL = panelUrl ? origin(panelUrl) : null;

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);

let passed = 0;
let failed = 0;
let warned = 0;

const pass = (name, detail = '') => {
  passed++;
  console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, detail) => {
  failed++;
  console.log(`  FAIL  ${name} — ${detail}`);
};
const warn = (name, detail) => {
  warned++;
  console.log(`  warn  ${name} — ${detail}`);
};

async function get(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: controller.signal,
      ...options,
    });
    const body = options.head ? '' : await res.text();
    return { status: res.status, headers: res.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

async function check(name, fn) {
  try {
    const result = await fn();
    if (result === undefined || result === true) return pass(name);
    if (result?.warn) return warn(name, result.warn);
    if (result?.ok) return pass(name, result.detail);
    return fail(name, result?.detail ?? 'failed');
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

console.log(`\nStorefront: ${STORE}`);

await check('health endpoint reports ok', async () => {
  const { status, body } = await get(`${STORE}/api/health`);
  if (status !== 200) return { detail: `HTTP ${status} — the app cannot reach its database` };
  const parsed = JSON.parse(body);
  return parsed.status === 'ok' ? { ok: true } : { detail: JSON.stringify(parsed) };
});

let comboPath = null;

await check('homepage lists something to buy', async () => {
  const { status, body } = await get(`${STORE}/`);
  if (status !== 200) return { detail: `HTTP ${status}` };

  const combos = [...body.matchAll(/href="(\/comprar\/[a-z0-9_]+)"/g)].map((m) => m[1]);
  if (combos.length === 0) {
    return { detail: 'no combos on the homepage — is the catalog seeded and active?' };
  }
  comboPath = combos[0];
  return { ok: true, detail: `${new Set(combos).size} combo(s)` };
});

await check('a combo page renders', async () => {
  if (!comboPath) return { warn: 'skipped, no combo found' };
  const { status } = await get(`${STORE}${comboPath}`);
  return status === 200 ? { ok: true, detail: comboPath } : { detail: `HTTP ${status}` };
});

await check('flyer images actually resolve', async () => {
  const { body } = await get(`${STORE}/`);
  const srcs = [...body.matchAll(/<img[^>]+class="flyer"[^>]+src="([^"]+)"/g)].map((m) => m[1]);

  if (srcs.length === 0) return { warn: 'no flyers uploaded yet' };

  for (const src of srcs) {
    const url = src.startsWith('http') ? src : `${STORE}${src}`;
    const { status, headers } = await get(url);
    if (status !== 200) return { detail: `${src} returned HTTP ${status}` };
    if (!(headers.get('content-type') ?? '').startsWith('image/')) {
      return { detail: `${src} is not an image` };
    }
  }
  return { ok: true, detail: `${srcs.length} flyer(s)` };
});

for (const path of ['/legal/terminos', '/legal/privacidad']) {
  await check(`${path} is complete`, async () => {
    const { status, body } = await get(`${STORE}${path}`);
    if (status !== 200) return { detail: `HTTP ${status}` };
    // The build-time-env trap: an image built without LEGAL_* ships a notice
    // reading "[PENDIENTE: RFC]" that no restart can fix.
    const pending = [...body.matchAll(/\[PENDIENTE: ([^\]]+)\]/g)].map((m) => m[1]);
    return pending.length === 0
      ? { ok: true }
      : { detail: `unset: ${[...new Set(pending)].join(', ')}` };
  });
}

await check('comprobantes are not publicly reachable', async () => {
  // The single most damaging thing this deployment could get wrong: customer
  // bank receipts served to anyone who guesses a URL.
  const attempts = [
    '/media/comprobantes/LU-000001/x.jpg',
    '/media/flyers/../comprobantes/LU-000001/x.jpg',
  ];
  for (const path of attempts) {
    const { status } = await get(`${STORE}${path}`);
    if (status === 200) return { detail: `${path} returned 200` };
  }
  return { ok: true };
});

await check('order pages are marked noindex', async () => {
  const { headers } = await get(`${STORE}/pedido/LU-000000?id=0`);
  const tag = headers.get('x-robots-tag') ?? '';
  // The URL carries a player ID and the page shows what they bought.
  return tag.includes('noindex') ? { ok: true } : { detail: `X-Robots-Tag: ${tag || '(absent)'}` };
});

await check('robots.txt points at this deployment', async () => {
  const { status, body } = await get(`${STORE}/robots.txt`);
  if (status !== 200) return { detail: `HTTP ${status}` };
  if (!body.includes('Disallow: /pedido/')) return { detail: 'order pages are not disallowed' };

  const sitemap = /Sitemap:\s*(\S+)/.exec(body)?.[1];
  if (!sitemap) return { detail: 'no sitemap declared' };
  // Catches a build that froze PUBLIC_DOMAIN at the wrong value.
  return sitemap.startsWith(STORE)
    ? { ok: true }
    : { detail: `sitemap points at ${sitemap}, not ${STORE}` };
});

await check('sitemap lists the catalog', async () => {
  const { status, body } = await get(`${STORE}/sitemap.xml`);
  if (status !== 200) return { detail: `HTTP ${status}` };
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const combos = locs.filter((l) => l.includes('/comprar/'));
  if (combos.length === 0) return { detail: 'no combos in the sitemap' };
  const wrong = locs.find((l) => !l.startsWith(STORE));
  if (wrong) return { detail: `points at another domain: ${wrong}` };
  return { ok: true, detail: `${locs.length} URLs, ${combos.length} combos` };
});

await check('share preview image renders', async () => {
  // Links are pasted into WhatsApp and TikTok; a broken card is a real cost.
  const { status, headers } = await get(`${STORE}/opengraph-image`);
  if (status !== 200) return { detail: `HTTP ${status}` };
  return (headers.get('content-type') ?? '').startsWith('image/')
    ? { ok: true }
    : { detail: `content-type ${headers.get('content-type')}` };
});

await check('404s are handled', async () => {
  const { status } = await get(`${STORE}/no-existe-esta-pagina`);
  return status === 404 ? { ok: true } : { detail: `HTTP ${status}, expected 404` };
});

if (PANEL) {
  console.log(`\nAdmin panel: ${PANEL}`);

  await check('panel health reports ok', async () => {
    const { status, body } = await get(`${PANEL}/api/health`);
    if (status !== 200) return { detail: `HTTP ${status}` };
    return JSON.parse(body).status === 'ok' ? { ok: true } : { detail: body };
  });

  await check('panel requires a session', async () => {
    const { status, headers } = await get(`${PANEL}/`);
    // Anything other than a redirect to the login page means the panel — which
    // approves payments and displays bank receipts — is readable without one.
    if (status === 200) return { detail: 'the panel root rendered without a session' };
    const location = headers.get('location') ?? '';
    return status >= 300 && status < 400 && location.includes('/login')
      ? { ok: true }
      : { detail: `HTTP ${status} → ${location || '(no location)'}` };
  });

  await check('panel is not indexable', async () => {
    const { headers } = await get(`${PANEL}/login`);
    const tag = headers.get('x-robots-tag') ?? '';
    return tag.includes('noindex') ? { ok: true } : { detail: `X-Robots-Tag: ${tag || '(absent)'}` };
  });

  await check('comprobante route refuses anonymous callers', async () => {
    const { status } = await get(
      `${PANEL}/api/comprobante/00000000-0000-0000-0000-000000000000`,
    );
    return status === 401 || status === 404
      ? { ok: true, detail: `HTTP ${status}` }
      : { detail: `HTTP ${status}, expected 401` };
  });
}

console.log(
  `\n${passed} passed, ${failed} failed, ${warned} warning(s)\n` +
    (failed === 0
      ? 'Deployment looks healthy. Still place one real order end to end before announcing it.\n'
      : 'Deployment is NOT healthy. Fix the failures above before sending anyone to the site.\n'),
);

process.exit(failed === 0 ? 0 : 1);
