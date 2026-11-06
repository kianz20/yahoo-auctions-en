'use strict';
// Local-only server: fetches Yahoo! Auctions pages, extracts the JSON embedded in
// them, and serves a small English UI. Translation happens in the browser (Chrome's
// on-device Translator API), so nothing here translates anything.
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3210;
const HOST = '127.0.0.1';
const YAHOO = 'https://auctions.yahoo.co.jp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGE_SIZE = 50;
const PAGE_TTL = 60_000;
const RATE_TTL = 6 * 3_600_000;
const RATE_FILE = path.join(__dirname, '.cache', 'rate.json');

const PREFECTURES = ['Hokkaido', 'Aomori', 'Iwate', 'Miyagi', 'Akita', 'Yamagata', 'Fukushima', 'Ibaraki', 'Tochigi', 'Gunma', 'Saitama', 'Chiba', 'Tokyo', 'Kanagawa', 'Niigata', 'Toyama', 'Ishikawa', 'Fukui', 'Yamanashi', 'Nagano', 'Gifu', 'Shizuoka', 'Aichi', 'Mie', 'Shiga', 'Kyoto', 'Osaka', 'Hyogo', 'Nara', 'Wakayama', 'Tottori', 'Shimane', 'Okayama', 'Hiroshima', 'Yamaguchi', 'Tokushima', 'Kagawa', 'Ehime', 'Kochi', 'Fukuoka', 'Saga', 'Nagasaki', 'Kumamoto', 'Oita', 'Miyazaki', 'Kagoshima', 'Okinawa'];

// Yahoo's bid-count sort is inverted: o1=a yields -BID_COUNT (most bids first).
const SORTS = {
  ending: { s1: 'end', o1: 'a' },
  newest: { s1: 'new', o1: 'd' },
  price_asc: { s1: 'cbids', o1: 'a' },
  price_desc: { s1: 'cbids', o1: 'd' },
  bids: { s1: 'bids', o1: 'a' },
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---- Yahoo fetching ------------------------------------------------------

const pageCache = new Map();

async function fetchState(url) {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.state;

  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.8' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new HttpError(502, `Couldn't reach Yahoo! Auctions (${err.message}).`);
  }
  const html = await res.text();
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) {
    if (res.status === 404) throw new HttpError(404, 'Yahoo has no page for that.');
    throw new HttpError(502, `Yahoo returned an unexpected page (HTTP ${res.status}). It may be blocking requests, or its page format may have changed.`);
  }
  const state = JSON.parse(match[1])?.props?.pageProps?.initialState;
  if (!state) throw new HttpError(502, "Yahoo's page format has changed, so this tool needs updating.");

  if (pageCache.size >= 200) pageCache.delete(pageCache.keys().next().value);
  pageCache.set(url, { at: Date.now(), state });
  return state;
}

// ---- Search --------------------------------------------------------------

function toListing(i) {
  const code = Number(i.prefectureCode);
  return {
    id: String(i.auctionId),
    title: i.title,
    image: i.imageUrl,
    price: i.price, // Yahoo's search prices already include tax.
    buyNow: i.buyNowPrice,
    bids: i.bidCount,
    watchers: i.watchCount,
    endTime: i.endTime,
    condition: i.itemCondition,
    freeShipping: Boolean(i.isFreeShipping),
    shippingFee: i.hasShippingFee ? i.currentPriceShippingFee ?? i.buyNowPriceShippingFee ?? null : null,
    fixedPrice: Boolean(i.isFixedPrice),
    promoted: Boolean(i.isFeatured),
    isStore: Boolean(i.seller?.isStore),
    rating: i.seller?.goodRating ?? null,
    location: PREFECTURES[code - 1] ?? null,
  };
}

const wholeNumber = (v) => (/^\d{1,12}$/.test(v ?? '') ? v : null);

async function search(params) {
  const q = new URLSearchParams();
  const p = (params.get('p') ?? '').slice(0, 200).trim();
  const cat = wholeNumber(params.get('cat'));
  if (!p && !cat) throw new HttpError(400, 'Enter a search term or choose a category.');
  if (p) q.set('p', p);
  if (cat) q.set('auccat', cat);

  const sort = SORTS[params.get('sort')];
  if (sort) { q.set('s1', sort.s1); q.set('o1', sort.o1); }
  if (params.get('type') === 'buynow') q.set('fixed', '1');
  if (params.get('type') === 'auction') q.set('fixed', '2');
  if (params.get('cond') === 'new') q.set('istatus', '1');
  if (params.get('cond') === 'used') q.set('istatus', '2');
  if (params.get('free') === '1') q.set('pstagefree', '1');

  const min = wholeNumber(params.get('min'));
  const max = wholeNumber(params.get('max'));
  if (min || max) {
    q.set('price_type', 'currentprice');
    if (min) q.set('min', min);
    if (max) q.set('max', max);
  }

  const page = Math.max(1, Number(wholeNumber(params.get('page'))) || 1);
  q.set('n', String(PAGE_SIZE));
  if (page > 1) q.set('b', String((page - 1) * PAGE_SIZE + 1));

  const url = `${YAHOO}/search/search?${q}`;
  const state = await fetchState(url);
  const listing = state.search?.items?.listing;
  if (!listing?.items) throw new HttpError(502, "Yahoo's search format has changed, so this tool needs updating.");

  const category = listing.modules?.category;
  return {
    total: listing.totalResultsAvailable ?? 0,
    page,
    pageSize: PAGE_SIZE,
    yahooUrl: url,
    items: listing.items.map(toListing),
    category: category?.current ? { id: category.current.id, name: category.current.name } : null,
    categories: (category?.children ?? []).map((c) => ({ id: c.id, name: c.name, count: c.count })),
  };
}

// ---- Item ----------------------------------------------------------------

async function item(id) {
  const url = `${YAHOO}/jp/auction/${id}`;
  const detail = (await fetchState(url)).item?.detail;
  if (detail?.error) throw new HttpError(detail.error.status || 502, "That listing wasn't found. It may have ended and been removed.");
  const it = detail?.item;
  if (!it) throw new HttpError(502, "Yahoo's listing format has changed, so this tool needs updating.");

  return {
    id: it.auctionId,
    url,
    title: it.title,
    images: (it.img ?? []).map((m) => ({ full: m.image, thumb: m.thumbnail })),
    // Store listings report a pre-tax `price`; `taxin*` is what the buyer actually pays.
    price: it.taxinPrice || it.price,
    startPrice: it.taxinStartPrice || it.initPrice,
    buyNow: it.taxinBidorbuy || it.bidorbuy || null,
    // Item pages have no fixed-price flag: a Buy Now price equal to the start price means one.
    fixedPrice: Boolean(it.bidorbuy) && it.bidorbuy === it.initPrice,
    bids: it.bids,
    bidders: it.biddersNum,
    watchers: it.watchListNum,
    quantity: it.quantity,
    status: it.status,
    startTime: it.startTime,
    endTime: it.endTime,
    condition: it.conditionName,
    autoExtend: Boolean(it.isAutomaticExtension),
    earlyClose: Boolean(it.isEarlyClosing),
    shippingPayer: it.chargeForShipping,
    shippingMethods: (it.shipping?.methods ?? []).map((m) => m.name),
    worldwide: Boolean(it.isWorldwideDelivery),
    returnsAllowed: Boolean(it.itemReturnable?.allowed),
    returnsNote: it.itemReturnable?.comment ?? '',
    categoryPath: (it.category?.path ?? []).slice(1).map((c) => ({ id: c.id, name: c.name })),
    seller: {
      name: it.seller?.displayName ?? '',
      isStore: Boolean(it.seller?.isStore),
      rating: it.seller?.rating?.goodRating ?? null,
      reviews: it.seller?.rating?.summary ?? null,
      location: it.seller?.location?.prefecture ?? '',
      url: it.seller?.listUrl ?? null,
    },
    descriptionHtml: sanitizeHtml(it.descriptionHtml || (it.description ?? []).join('<br>')),
  };
}

// Seller descriptions are arbitrary HTML, so rebuild them from an allow-list.
const KEEP_TAGS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'b', 'strong', 'i', 'em', 'u', 'small', 'br', 'hr', 'p', 'div', 'span', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const RENAME_TAGS = { font: 'span', center: 'div' };
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'template', 'textarea', 'select', 'title', 'head']);

function sanitizeHtml(html) {
  const out = [];
  const token = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
  let skipping = null;
  for (const m of html.matchAll(token)) {
    const [raw, slash, rawName, attrs] = m;
    const name = rawName?.toLowerCase();
    if (skipping) {
      if (slash && name === skipping) skipping = null;
      continue;
    }
    if (!name) {
      if (raw === '<') out.push('&lt;');
      else if (!raw.startsWith('<!--')) out.push(raw);
      continue;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      if (!slash && !/\/\s*$/.test(attrs)) skipping = name;
      continue;
    }
    if (name === 'img') {
      const src = attrs.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const value = src && (src[1] ?? src[2] ?? src[3]);
      if (value && /^https?:\/\/[^\s"'<>]+$/.test(value)) out.push(`<img src="${value.replace(/&(?!amp;)/g, '&amp;')}" loading="lazy" referrerpolicy="no-referrer" alt="">`);
      continue;
    }
    const tag = RENAME_TAGS[name] ?? name;
    if (!KEEP_TAGS.has(tag)) continue;
    if (slash) { out.push(`</${tag}>`); continue; }
    let safeAttrs = '';
    if (tag === 'td' || tag === 'th') {
      for (const span of ['colspan', 'rowspan']) {
        const v = attrs.match(new RegExp(`\\b${span}\\s*=\\s*["']?(\\d{1,2})`, 'i'));
        if (v) safeAttrs += ` ${span}="${v[1]}"`;
      }
    }
    out.push(`<${tag}${safeAttrs}>`);
  }
  return out.join('');
}

// ---- Exchange rate -------------------------------------------------------

let rate = null;
try { rate = JSON.parse(fs.readFileSync(RATE_FILE, 'utf8')); } catch { /* first run */ }

async function getRate() {
  if (rate && Date.now() - rate.fetchedAt < RATE_TTL) return rate;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/JPY', { signal: AbortSignal.timeout(10_000) });
    const data = await res.json();
    const nzdPerJpy = data?.rates?.NZD;
    if (data?.result !== 'success' || !(nzdPerJpy > 0)) throw new Error('bad response');
    rate = { nzdPerJpy, updated: data.time_last_update_utc, fetchedAt: Date.now() };
    fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
    fs.writeFileSync(RATE_FILE, JSON.stringify(rate));
    return rate;
  } catch (err) {
    if (rate) return { ...rate, stale: true }; // An old rate, flagged as such, beats no prices.
    throw new HttpError(502, `Couldn't get an exchange rate (${err.message}).`);
  }
}

// ---- HTTP ----------------------------------------------------------------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src https: http:; connect-src 'self'; base-uri 'none'; form-action 'none'";

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}
const sendJson = (res, status, data) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));

const server = http.createServer(async (req, res) => {
  // Only answer to localhost names, so other websites can't reach this via DNS rebinding.
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return send(res, 403, 'text/plain', 'Forbidden');
  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');

  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
    if (STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(res, 200, type, fs.readFileSync(path.join(__dirname, 'public', file)));
    }
    if (pathname === '/api/rate') return sendJson(res, 200, await getRate());
    if (pathname === '/api/search') return sendJson(res, 200, await search(searchParams));
    const itemMatch = pathname.match(/^\/api\/item\/([a-zA-Z]?\d{6,})$/);
    if (itemMatch) return sendJson(res, 200, await item(itemMatch[1]));
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    sendJson(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Something went wrong on the local server.' });
  }
});

// With --open, use a Chrome profile just for this app. Language packs can stall in an
// everyday profile, and a separate profile runs alongside any Chrome that's already open.
function openChrome() {
  if (!process.argv.includes('--open')) return;
  const profile = process.env.CHROME_PROFILE_DIR || path.join(__dirname, '.chrome-profile');
  const extraFlags = (process.env.CHROME_EXTRA_FLAGS || '').split(' ').filter(Boolean);
  spawn('cmd', ['/c', 'start', '', 'chrome', `--user-data-dir=${profile}`, '--no-first-run', ...extraFlags, `http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. It may already be running: try http://localhost:${PORT}`);
    openChrome();
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Yahoo Auctions in English: http://localhost:${PORT}  (open in Chrome, Ctrl+C to stop)`);
  openChrome();
});
