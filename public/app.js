'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//.test(u ?? '') ? u : '');

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// ---- Fixed vocabulary (more accurate than machine translation) -----------

const ROOT_CATEGORIES = [
  [26318, 'Cars & Motorcycles'], [23632, 'Electronics, AV & Cameras'], [23336, 'Computers'],
  [23000, 'Fashion'], [23140, 'Accessories & Watches'], [25464, 'Toys & Games'],
  [20060, 'Comics & Anime Goods'], [20000, 'Antiques & Collectibles'], [24242, 'Hobbies & Culture'],
  [22152, 'Music'], [21964, 'Film & Video'], [21600, 'Books & Magazines'],
  [24698, 'Sports & Leisure'], [24198, 'Home & Interior'], [42177, 'Beauty & Health'],
  [2084032594, 'Celebrity Merchandise'], [22896, 'Office & Store Supplies'], [24202, 'Baby Goods'],
  [26086, 'Flowers & Gardening'], [23976, 'Food & Drink'], [2084055844, 'Pets & Animals'],
  [2084043920, 'Tickets, Vouchers & Stays'], [26084, 'Other'],
];
const ROOT_NAMES = new Map(ROOT_CATEGORIES.map(([id, name]) => [id, name]));

const CONDITION_CODES = {
  NEW: 'New / unused', USED10: 'Like new', USED20: 'No obvious marks',
  USED40: 'Some marks or dirt', USED60: 'Marks or dirt', USED80: 'Poor condition',
};
const CONDITION_NAMES = {
  '未使用': 'New / unused', '未使用に近い': 'Like new', '目立った傷や汚れなし': 'No obvious marks',
  'やや傷や汚れあり': 'Some marks or dirt', '傷や汚れあり': 'Marks or dirt', '全体的に状態が悪い': 'Poor condition',
};
const RETURNS_NOTES = {
  '返品の可否は条件次第ですので、詳細をご確認下さい': "Depends on the seller's conditions, so check the details.",
};

// ---- Currency ------------------------------------------------------------

let rate = null;
const loadRate = api('/api/rate').then((r) => {
  rate = r;
  const updated = new Date(r.updated).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  $('#rate-line').textContent = `¥1,000 ≈ NZ$${(r.nzdPerJpy * 1000).toFixed(2)} (mid-market rate from ${updated}). Your card or proxy service will use a slightly different rate.`;
  if (r.stale) showRateBanner(`Couldn't refresh the exchange rate, so NZD prices use the last known rate from ${updated}.`);
}).catch(() => showRateBanner("Couldn't get an exchange rate, so prices are shown in yen only."));

function showRateBanner(text) {
  const el = $('#rate-banner');
  el.textContent = text;
  el.hidden = false;
}

const yen = (n) => `¥${Math.round(n).toLocaleString('en-NZ')}`;
function nzd(jpy) {
  const v = jpy * rate.nzdPerJpy;
  // Cents matter on cheap items, and are just noise on expensive ones.
  return `NZ$${v.toLocaleString('en-NZ', v >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
const money = (jpy) => (rate ? nzd(jpy) : yen(jpy));
const moneySub = (jpy) => (rate ? yen(jpy) : '');

// ---- Translation (Chrome's on-device Translator API) ---------------------

const JAPANESE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
const hasJapanese = (s) => JAPANESE.test(s);

const STALL_MS = 60_000;
const DIRECTIONS = [
  { key: 'ja2en', sourceLanguage: 'ja', targetLanguage: 'en' }, // Reading listings
  { key: 'en2ja', sourceLanguage: 'en', targetLanguage: 'ja' }, // Searching in English
];

const Translate = {
  state: 'checking', // checking | unsupported | needs-download | downloading | stalled | ready | failed
  pending: null,
  stallTimer: null,
  ja2en: null,
  en2ja: null,
  started: false, // Set once the first page has rendered.
  cache: new Map(),
  queue: Promise.resolve(),
  generation: 0, // Bumped on navigation so stale work is skipped.

  // Chrome only allows one language-pack download per click, so each direction
  // that isn't installed yet gets its own "Turn on" button.
  async setup(clicked = false) {
    if (!('Translator' in self)) return this.setState('unsupported');
    try {
      for (const { key, ...languages } of DIRECTIONS) {
        if (this[key]) continue;
        const availability = await Translator.availability(languages);
        if (availability === 'unavailable') return this.setState('unsupported');
        if (availability !== 'available') {
          if (!clicked) return this.setState('needs-download', key);
          clicked = false;
          this.setState('downloading', 0);
          this.watchForStall();
        }
        this.pending = new AbortController();
        this[key] = await Translator.create({
          ...languages,
          signal: this.pending.signal,
          monitor: (m) => m.addEventListener('downloadprogress', (e) => {
            // Chrome reports 0% before it has actually started, so only later progress counts.
            if (e.loaded > 0 && (this.state === 'downloading' || this.state === 'stalled')) {
              this.setState('downloading', e.loaded);
              this.watchForStall();
            }
          }),
        });
        clearTimeout(this.stallTimer);
        if (this.started) route(); // Re-render so what's on screen gets translated.
      }
      this.setState('ready');
    } catch (err) {
      clearTimeout(this.stallTimer);
      if (err.name === 'AbortError') return; // Replaced by a retry, which now owns the banner.
      console.error(err);
      this.setState('failed');
    }
  },

  // create() can wait forever if Chrome's downloader never starts, so don't wait silently.
  // A download that resumes after this still finishes normally.
  watchForStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.state === 'downloading') this.setState('stalled');
    }, STALL_MS);
  },

  retry() {
    clearTimeout(this.stallTimer);
    this.pending?.abort();
    this.setup(true);
  },

  setState(state, detail) {
    this.state = state;
    const el = $('#translator-banner');
    el.hidden = state === 'ready' || state === 'checking';
    const withButton = (text, label, onClick) => {
      el.innerHTML = `<span>${esc(text)}</span> <button id="tr-enable" type="button">${esc(label)}</button>`;
      $('#tr-enable').addEventListener('click', onClick);
    };
    if (state === 'needs-download') {
      const intro = detail === 'ja2en'
        ? 'Turn on English translation. This downloads a language pack from Chrome once, then runs privately on this computer.'
        : 'One more step: turn on searching in English. This downloads the second language pack.';
      withButton(intro, 'Turn on', () => this.setup(true));
    } else if (state === 'downloading') {
      el.textContent = detail > 0 ? `Downloading language pack… ${Math.round(detail * 100)}%` : 'Waiting for Chrome to start the language pack download…';
    } else if (state === 'stalled') {
      withButton("Chrome hasn't started the language pack download, so listings are in Japanese for now. Try again, or close Chrome completely and reopen this page with start.bat.", 'Try again', () => this.retry());
    } else if (state === 'unsupported') {
      el.textContent = "This browser doesn't have a built-in Japanese translator, so listings stay in Japanese. Open this page in an up-to-date Chrome on your computer.";
    } else if (state === 'failed') {
      // Common just after installing Chrome or on a new profile, while it fetches its translation files.
      withButton("Chrome's translator isn't ready yet, so listings are in Japanese for now. Give it a minute, then try again.", 'Try again', () => this.retry());
    }
  },

  // Runs one at a time; requests from a previous page are dropped.
  run(translator, text) {
    const key = `${translator === this.ja2en ? 'je' : 'ej'}:${text}`;
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    const generation = this.generation;
    const job = this.queue.then(async () => {
      if (generation !== this.generation) return null;
      if (this.cache.has(key)) return this.cache.get(key);
      const result = (await translator.translate(text)).trim();
      this.cache.set(key, result);
      return result;
    });
    this.queue = job.catch(() => {});
    return job.catch((err) => { console.error(err); return null; });
  },

  toEnglish(text) {
    const clean = String(text ?? '').replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || !hasJapanese(clean) || !this.ja2en) return Promise.resolve(null);
    return this.run(this.ja2en, clean);
  },

  toJapanese(text) {
    if (!this.en2ja) return Promise.resolve(null);
    return this.run(this.en2ja, text);
  },
};

// Fill in every [data-tr] element, top to bottom. Elements show Japanese until done.
function translateElements(root) {
  for (const el of root.querySelectorAll('[data-tr]')) {
    const original = el.textContent;
    Translate.toEnglish(original).then((english) => {
      if (english && el.isConnected) {
        el.textContent = english;
        el.removeAttribute('data-tr');
        el.lang = 'en';
      }
    });
  }
}

function translateTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (hasJapanese(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    Translate.toEnglish(node.nodeValue).then((english) => { if (english) node.nodeValue = ` ${english} `; });
  }
}

// ---- Time ----------------------------------------------------------------

function timeLeft(endTime) {
  const ms = new Date(endTime) - Date.now();
  if (ms <= 0) return { text: 'Ended', ended: true };
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  const text = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s % 60)}s`;
  return { text, urgent: s < 3600 };
}
function tickCountdowns() {
  for (const el of document.querySelectorAll('[data-end]')) {
    const t = timeLeft(el.dataset.end);
    el.textContent = t.text;
    el.classList.toggle('urgent', Boolean(t.urgent));
    el.classList.toggle('ended', Boolean(t.ended));
  }
}
setInterval(tickCountdowns, 1000);

const localEnd = (iso) => new Date(iso).toLocaleString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

// ---- Routing -------------------------------------------------------------

const scrollMemory = new Map();
let currentHash = null;
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

function route() {
  if (currentHash) scrollMemory.set(currentHash, scrollY);
  currentHash = location.hash;
  Translate.generation++;
  const hash = location.hash.slice(1) || '/';
  const [path, query = ''] = hash.split('?');
  const itemMatch = path.match(/^\/item\/([a-zA-Z]?\d{6,})$/);
  if (itemMatch) return renderItem(itemMatch[1]);
  if (path === '/search') return renderSearch(new URLSearchParams(query));
  renderHome();
}
window.addEventListener('hashchange', route);

function restoreScroll() {
  scrollTo(0, scrollMemory.get(location.hash) ?? 0);
}

function searchHash(params) {
  return `#/search?${new URLSearchParams([...params].filter(([, v]) => v))}`;
}

// A pasted Yahoo link or auction ID goes straight to that listing.
function auctionIdFrom(text) {
  const link = text.match(/yahoo\.co\.jp\/.*?auction\/([a-zA-Z]?\d{6,})/);
  if (link) return link[1];
  return /^[a-zA-Z]\d{8,}$/.test(text) ? text : null;
}

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#q').value.trim();
  if (!text) return;
  const id = auctionIdFrom(text);
  location.hash = id ? `#/item/${id}` : searchHash(new URLSearchParams({ q: text }));
});

function showError(message, yahooUrl) {
  view.innerHTML = `<div class="message"><h1>That didn't work</h1><p>${esc(message)}</p>
    <p><a href="#/">Back to start</a>${safeUrl(yahooUrl) ? ` · <a href="${esc(yahooUrl)}" target="_blank" rel="noreferrer">Try on Yahoo directly</a>` : ''}</p></div>`;
}

// ---- Home ----------------------------------------------------------------

function renderHome() {
  $('#q').value = '';
  document.title = 'Yahoo Auctions in English';
  view.innerHTML = `
    <section class="home">
      <h1>Browse Japan's biggest auction site in English, priced in NZ dollars.</h1>
      <p>Search in English above, paste any Yahoo auction link, or start with a category.</p>
      <div class="cat-grid">
        ${ROOT_CATEGORIES.map(([id, name]) => `<a href="#/search?cat=${id}">${esc(name)}</a>`).join('')}
      </div>
    </section>`;
  restoreScroll();
}

// ---- Search --------------------------------------------------------------

const SORT_OPTIONS = [['', 'Best match'], ['ending', 'Ending soonest'], ['newest', 'Newly listed'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['bids', 'Most bids']];
const TYPE_OPTIONS = [['', 'Auctions & Buy Now'], ['auction', 'Auctions only'], ['buynow', 'Buy Now only']];
const COND_OPTIONS = [['', 'Any condition'], ['new', 'New'], ['used', 'Used']];
const options = (list, selected) => list.map(([v, label]) => `<option value="${v}"${v === (selected ?? '') ? ' selected' : ''}>${label}</option>`).join('');

function skeletonGrid() {
  return `<div class="grid">${'<div class="card skeleton"><div class="thumb"></div><div class="card-body"><i></i><i></i><i></i></div></div>'.repeat(12)}</div>`;
}

async function renderSearch(params) {
  const typed = params.get('q') ?? '';
  $('#q').value = typed;
  document.title = `${typed || 'Browse'} | Yahoo Auctions in English`;
  view.innerHTML = `<div class="results">${skeletonGrid()}</div>`;
  const generation = Translate.generation;

  await loadRate;
  // Translate the query unless it's already Japanese or the user asked for it as typed.
  let yahooQuery = typed;
  if (typed && !hasJapanese(typed) && params.get('raw') !== '1') {
    yahooQuery = (await Translate.toJapanese(typed)) || typed;
  }
  if (generation !== Translate.generation) return;

  const req = new URLSearchParams();
  if (yahooQuery) req.set('p', yahooQuery);
  for (const key of ['cat', 'sort', 'type', 'cond', 'free', 'page']) if (params.get(key)) req.set(key, params.get(key));
  if (rate) {
    if (Number(params.get('min')) > 0) req.set('min', Math.floor(params.get('min') / rate.nzdPerJpy));
    if (Number(params.get('max')) > 0) req.set('max', Math.ceil(params.get('max') / rate.nzdPerJpy));
  }

  let data;
  try {
    data = await api(`/api/search?${req}`);
  } catch (err) {
    if (generation === Translate.generation) showError(err.message);
    return;
  }
  if (generation !== Translate.generation) return;

  const withParam = (key, value) => {
    const next = new URLSearchParams(params);
    next.delete('page');
    if (value) next.set(key, value); else next.delete(key);
    return searchHash(next);
  };
  const pageHash = (n) => {
    const next = new URLSearchParams(params);
    if (n > 1) next.set('page', n); else next.delete('page');
    return searchHash(next);
  };

  const cat = Number(params.get('cat'));
  const catName = ROOT_NAMES.get(cat);
  const heading = typed || catName || (data.category?.name ?? 'Listings');
  const translatedNote = yahooQuery !== typed
    ? `<p class="note">Searched Yahoo for <b lang="ja">${esc(yahooQuery)}</b>. <a href="${esc(withParam('raw', '1'))}">Search for “${esc(typed)}” exactly as typed</a></p>`
    : '';

  const hasNext = data.page * data.pageSize < data.total && data.items.length === data.pageSize;
  view.innerHTML = `
    <div class="results">
      <div class="results-head">
        <h1 ${!typed && !catName && hasJapanese(heading) ? 'data-tr' : ''}>${esc(heading)}</h1>
        <p class="count">${data.total.toLocaleString('en-NZ')} listings</p>
      </div>
      ${translatedNote}
      <form id="filters" class="filters">
        <select name="sort" aria-label="Sort by">${options(SORT_OPTIONS, params.get('sort'))}</select>
        <select name="type" aria-label="Listing type">${options(TYPE_OPTIONS, params.get('type'))}</select>
        <select name="cond" aria-label="Condition">${options(COND_OPTIONS, params.get('cond'))}</select>
        ${rate ? `<span class="price-range">
          <input name="min" type="number" min="0" inputmode="numeric" placeholder="Min NZ$" aria-label="Minimum price in NZ dollars" value="${esc(params.get('min'))}">
          <input name="max" type="number" min="0" inputmode="numeric" placeholder="Max NZ$" aria-label="Maximum price in NZ dollars" value="${esc(params.get('max'))}">
        </span>` : ''}
        <label class="check"><input type="checkbox" name="free" value="1"${params.get('free') === '1' ? ' checked' : ''}> Free shipping in Japan</label>
      </form>
      ${data.categories.length ? `<nav class="cat-chips" aria-label="Narrow by category">
        ${data.categories.slice(0, 24).map((c) => `<a href="${esc(withParam('cat', String(c.id)))}"><span ${ROOT_NAMES.has(c.id) ? '' : 'data-tr'}>${esc(ROOT_NAMES.get(c.id) ?? c.name)}</span>${c.count ? ` <small>${c.count.toLocaleString('en-NZ')}</small>` : ''}</a>`).join('')}
      </nav>` : ''}
      ${data.items.length ? `<div class="grid">${data.items.map(cardHtml).join('')}</div>` : `
        <div class="message"><h2>No listings found</h2><p>Try fewer words, a Japanese brand name, or removing filters.</p></div>`}
      <nav class="pager" aria-label="Pages">
        ${data.page > 1 ? `<a href="${esc(pageHash(data.page - 1))}">← Previous</a>` : '<span></span>'}
        <span>Page ${data.page}</span>
        ${hasNext ? `<a href="${esc(pageHash(data.page + 1))}">Next →</a>` : '<span></span>'}
      </nav>
    </div>`;

  $('#filters').addEventListener('change', (e) => {
    const form = new FormData(e.currentTarget);
    const next = new URLSearchParams(params);
    next.delete('page');
    for (const key of ['sort', 'type', 'cond', 'min', 'max']) {
      if (form.get(key)) next.set(key, form.get(key)); else next.delete(key);
    }
    if (form.get('free')) next.set('free', '1'); else next.delete('free');
    location.hash = searchHash(next);
  });
  $('#filters').addEventListener('submit', (e) => e.preventDefault());

  tickCountdowns();
  restoreScroll();
  translateElements(view);
}

function cardHtml(i) {
  const shipping = i.freeShipping ? 'Free shipping in Japan'
    : i.shippingFee ? `+ ${money(i.shippingFee)} shipping in Japan` : '';
  const showBuyNow = i.buyNow && !i.fixedPrice;
  return `
    <a class="card" href="#/item/${esc(i.id)}">
      <div class="thumb"><img src="${esc(safeUrl(i.image))}" alt="" loading="lazy"></div>
      <div class="card-body">
        <h2 class="card-title" data-tr lang="ja">${esc(i.title)}</h2>
        <p class="price">${esc(money(i.price))} <small>${esc(moneySub(i.price))}</small></p>
        ${showBuyNow ? `<p class="meta">Buy Now ${esc(money(i.buyNow))}</p>` : ''}
        <p class="meta">
          ${i.fixedPrice ? '<span>Buy Now</span>' : `<span>${i.bids} ${i.bids === 1 ? 'bid' : 'bids'}</span>`}
          <span data-end="${esc(i.endTime)}"></span>
        </p>
        <p class="meta dim">${[CONDITION_CODES[i.condition], i.location].filter(Boolean).map(esc).join(' · ')}</p>
        ${shipping ? `<p class="meta dim">${esc(shipping)}</p>` : ''}
        ${i.promoted ? '<p class="meta dim">Promoted</p>' : ''}
      </div>
    </a>`;
}

// ---- Item ----------------------------------------------------------------

async function renderItem(id) {
  view.innerHTML = '<div class="message"><p>Loading listing…</p></div>';
  const generation = Translate.generation;
  await loadRate;
  let it;
  try {
    it = await api(`/api/item/${id}`);
  } catch (err) {
    if (generation === Translate.generation) showError(err.message, `https://auctions.yahoo.co.jp/jp/auction/${id}`);
    return;
  }
  if (generation !== Translate.generation) return;
  document.title = `${it.title} | Yahoo Auctions in English`;

  const open = it.status === 'open';
  const condition = CONDITION_NAMES[it.condition] ?? it.condition;
  const shippingPayer = it.shippingPayer === 'seller' ? 'Free within Japan (seller pays)' : 'Buyer pays Japan shipping';
  const priceLabel = !open ? 'Final price' : it.fixedPrice ? 'Price' : it.bids > 0 ? 'Current bid' : 'Starting bid';

  view.innerHTML = `
    <article class="item">
      <nav class="crumbs" aria-label="Category">
        ${it.categoryPath.map((c) => {
          const known = ROOT_NAMES.get(Number(c.id));
          return `<a href="#/search?cat=${esc(c.id)}"><span ${known ? '' : 'data-tr'}>${esc(known ?? c.name)}</span></a>`;
        }).join('<span aria-hidden="true"> › </span>')}
      </nav>
      <div class="item-top">
        <div class="gallery">
          <div class="gallery-main">
            ${it.images[0] ? `<img id="main-img" src="${esc(safeUrl(it.images[0].full))}" alt="">` : '<p class="dim">No photos</p>'}
          </div>
          ${it.images.length > 1 ? `<div class="thumbs">
            ${it.images.map((m, n) => `<button type="button" data-full="${esc(safeUrl(m.full))}" aria-label="Photo ${n + 1}"${n === 0 ? ' class="on"' : ''}><img src="${esc(safeUrl(m.thumb))}" alt=""></button>`).join('')}
          </div>` : ''}
        </div>
        <div class="buybox">
          <h1 data-tr lang="ja">${esc(it.title)}</h1>
          <p class="original" lang="ja">${esc(it.title)}</p>
          <div class="price-block">
            <p class="label">${priceLabel}</p>
            <p class="price big">${esc(money(it.price))} <small>${esc(moneySub(it.price))}</small></p>
            ${it.buyNow && !it.fixedPrice ? `<p class="meta">Buy Now: <b>${esc(money(it.buyNow))}</b> ${esc(moneySub(it.buyNow))}</p>` : ''}
          </div>
          <dl class="facts">
            ${open ? `<div><dt>Time left</dt><dd><span data-end="${esc(it.endTime)}"></span> <span class="dim">(ends ${esc(localEnd(it.endTime))})</span></dd></div>`
              : `<div><dt>Status</dt><dd>Ended ${esc(localEnd(it.endTime))}</dd></div>`}
            ${it.fixedPrice ? '' : `<div><dt>Bids</dt><dd>${it.bids > 0 ? `${it.bids} from ${it.bidders} ${it.bidders === 1 ? 'bidder' : 'bidders'}` : 'No bids yet'}</dd></div>`}
            <div><dt>Watching</dt><dd>${it.watchers}</dd></div>
            <div><dt>Condition</dt><dd ${CONDITION_NAMES[it.condition] ? '' : 'data-tr'}>${esc(condition)}</dd></div>
            <div><dt>Shipping</dt><dd>${esc(shippingPayer)}${it.shippingMethods.length ? `<br><span class="dim" data-tr>${esc(it.shippingMethods.join(', '))}</span>` : ''}</dd></div>
            <div><dt>Ships overseas</dt><dd>${it.worldwide ? 'Yes, according to the seller' : 'Not offered on Yahoo'}</dd></div>
            <div><dt>Returns</dt><dd>${it.returnsAllowed ? 'Possible' : 'Not accepted'}${it.returnsNote ? `<br><span class="dim" ${RETURNS_NOTES[it.returnsNote] ? '' : 'data-tr'}>${esc(RETURNS_NOTES[it.returnsNote] ?? it.returnsNote)}</span>` : ''}</dd></div>
            <div><dt>Seller</dt><dd><span data-tr>${esc(it.seller.name)}</span>${it.seller.isStore ? ' (store)' : ''}
              ${it.seller.rating ? `<br><span class="dim">${esc(it.seller.rating)} positive${it.seller.reviews != null ? ` from ${Number(it.seller.reviews).toLocaleString('en-NZ')} ratings` : ''}</span>` : ''}
              ${it.seller.location ? `<br><span class="dim" data-tr>${esc(it.seller.location)}</span>` : ''}</dd></div>
            ${open && !it.fixedPrice && (it.autoExtend || it.earlyClose) ? `<div><dt>Good to know</dt><dd class="dim">
              ${it.autoExtend ? 'Late bids extend the auction. ' : ''}${it.earlyClose ? 'The seller can end it early.' : ''}</dd></div>` : ''}
          </dl>
          <p class="actions">
            <a class="button" href="${esc(it.url)}" target="_blank" rel="noreferrer">Open on Yahoo</a>
          </p>
          <div class="buy-note">
            <h2>Buying from New Zealand</h2>
            <p>Bidding on Yahoo directly generally needs a Japanese account, and most sellers only ship within Japan. The usual route is a proxy service such as Buyee or ZenMarket: give them this auction ID and they bid and forward it to you.</p>
            <p class="copy-row"><code>${esc(it.id)}</code> <button id="copy-id" type="button">Copy ID</button></p>
            <p class="dim">NZD is a straight conversion. It doesn't include proxy fees, shipping, or any NZ GST or duty.</p>
          </div>
        </div>
      </div>
      <section class="description">
        <div class="description-head">
          <div>
            <h2>Seller's description</h2>
            <p>Machine translated, and it can get names and details wrong. Check anything important against the original.</p>
          </div>
          <button id="toggle-original" type="button" aria-pressed="false">Show original Japanese</button>
        </div>
        <div id="desc-en" class="desc-body">${it.descriptionHtml}</div>
        <div id="desc-ja" class="desc-body" lang="ja" hidden>${it.descriptionHtml}</div>
      </section>
    </article>`;

  const main = $('#main-img');
  view.querySelectorAll('.thumbs button').forEach((button) => {
    button.addEventListener('click', () => {
      main.src = button.dataset.full;
      view.querySelector('.thumbs .on')?.classList.remove('on');
      button.classList.add('on');
    });
  });
  $('#copy-id').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(it.id);
      e.target.textContent = 'Copied';
    } catch {
      e.target.textContent = "Couldn't copy";
    }
  });
  $('#toggle-original').addEventListener('click', (e) => {
    const showJa = $('#desc-ja').hidden;
    $('#desc-ja').hidden = !showJa;
    $('#desc-en').hidden = showJa;
    e.target.textContent = showJa ? 'Show English' : 'Show original Japanese';
    e.target.setAttribute('aria-pressed', String(showJa));
  });

  tickCountdowns();
  restoreScroll();
  translateElements(view);
  translateTextNodes($('#desc-en'));
}

// ---- Start ---------------------------------------------------------------

Translate.setup().finally(() => {
  Translate.started = true;
  route();
});
