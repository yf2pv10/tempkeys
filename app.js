// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — change this to your deployed Cloudflare Pages URL
// ═══════════════════════════════════════════════════════════════════════════
// API_BASE is set in config.js (loaded before app.js)
// If config.js is missing, fall back to the default URL
if (typeof API_BASE === 'undefined') {
  var API_BASE = 'https://marketplace-cloudflare-d1.pages.dev';
}

// ═══════════════════════════════════════════════════════════════════════════
// Marketplace Catalog — standalone frontend
// Fetches from the D1-backed API, renders items in a grid + detail view
// with hash-based routing (#/ , #/item/<uuid>, #/category/<cat>)
// ═══════════════════════════════════════════════════════════════════════════

const PAGE_SIZE = 24;
const PARALLEL_PAGES = 12;

// Category config — two groups: main categories + special filters
// Matches the toolcoin.site/marketplace/ layout
const CATEGORIES = [
  // ── Main Categories ──
  { key: 'discover',  label: 'Discover',  types: null, group: 'main' },
  { key: 'addons',    label: 'Add-On',    types: ['addon'], group: 'main' },
  { key: 'worlds',    label: 'World',     types: ['world'], group: 'main' },
  { key: 'mashups',   label: 'Mashups',   types: ['mashup'], group: 'main' },
  { key: 'textures',  label: 'Textures',  types: ['texturepack', 'texture'], group: 'main' },
  { key: 'skins',     label: 'Skins',     types: ['skinpack', 'skin'], group: 'main' },

  // ── Special Filters ──
  { key: 'scary',      label: 'Scary',          tagFilter: ['tag.horror', 'tag.halloween', 'tag.haunted', 'tag.scary_mobs', 'tag.spooky'], group: 'special' },
  { key: 'vibrant',    label: 'Vibrant Visuals', tagFilter: ['tag.vibrantvisuals'], group: 'special' },
  { key: 'persona',    label: 'Persona',        types: ['persona'], group: 'special' },
  { key: 'hidden',     label: 'Hidden Offers',  hiddenOnly: true, group: 'special' },
  { key: 'unfiltered',  label: 'Unfiltered',     types: null, group: 'special', includeHidden: true },
];

const SORT_OPTIONS = [
  { key: 'newest',  label: 'Newest' },
  { key: 'rating',  label: 'Top Rated' },
  { key: 'title',  label: 'A-Z' },
];

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════
let allItems = [];           // all fetched items (cached in memory + IndexedDB)
let totalPages = 0;
let totalItems = 0;
let currentCategory = 'discover';
let currentSort = 'newest';
let currentSearch = '';
let showHidden = false;
let isLoading = false;
let meta = null;

// ═══════════════════════════════════════════════════════════════════════════
// IndexedDB cache (so returning visitors don't re-fetch everything)
// ═══════════════════════════════════════════════════════════════════════════
const IDB_NAME = 'marketplace_catalog';
const IDB_VERSION = 1;
const IDB_STORE = 'cache';
const IDB_KEY = 'all_items';
const IDB_META_KEY = 'meta';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no IDB')); return; }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function idbSet(key, value) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// API helpers
// ═══════════════════════════════════════════════════════════════════════════
async function fetchMeta() {
  try {
    const res = await fetch(`${API_BASE}/api/marketplace/meta.json`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function fetchPage(n) {
  try {
    const res = await fetch(`${API_BASE}/api/marketplace/page-${n}.json`, { cache: 'force-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.items || [];
  } catch { return []; }
}

async function fetchItemDetail(uuid) {
  try {
    const res = await fetch(`${API_BASE}/api/marketplace/item/${uuid.toLowerCase()}.json`, { cache: 'force-cache' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.item || data;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Load all items (with IndexedDB cache)
// ═══════════════════════════════════════════════════════════════════════════
async function loadAllItems() {
  if (allItems.length > 0) return allItems;

  // Check IndexedDB first
  const cached = await idbGet(IDB_KEY);
  const cachedMeta = await idbGet(IDB_META_KEY);
  if (cached && cachedMeta && meta && cachedMeta.totalItems === meta.totalItems) {
    allItems = cached;
    totalPages = Math.ceil(allItems.length / PAGE_SIZE);
    totalItems = allItems.length;
    return allItems;
  }

  // Fetch all pages in parallel batches
  isLoading = true;
  updateLoadingIndicator();

  // Get total pages from meta
  meta = meta || await fetchMeta();
  totalItems = meta?.totalItems || 0;
  totalPages = meta?.totalPages || Math.ceil(totalItems / PAGE_SIZE) || 0;

  if (totalPages === 0) {
    showError('No items found. Run the crawler first: node scripts/crawl-local-to-d1.mjs');
    isLoading = false;
    updateLoadingIndicator();
    return [];
  }

  allItems = [];
  for (let batch = 0; batch < totalPages; batch += PARALLEL_PAGES) {
    const pages = [];
    for (let i = 0; i < PARALLEL_PAGES && batch + i < totalPages; i++) {
      pages.push(batch + i + 1); // pages are 1-indexed
    }
    const results = await Promise.all(pages.map(p => fetchPage(p)));
    for (const items of results) {
      allItems.push(...items);
    }
    updateLoadingIndicator();
  }

  // Cache in IndexedDB
  await idbSet(IDB_KEY, allItems);
  await idbSet(IDB_META_KEY, meta);

  isLoading = false;
  updateLoadingIndicator();
  return allItems;
}

// ═══════════════════════════════════════════════════════════════════════════
// Filtering + sorting
// ═══════════════════════════════════════════════════════════════════════════
function getFilteredItems() {
  let items = allItems;

  // Category filter
  const cat = CATEGORIES.find(c => c.key === currentCategory);
  if (cat) {
    // Type filter (addon, world, skinpack, etc.)
    if (cat.types) {
      items = items.filter(i => {
        const t = (i.type || '').toLowerCase().replace(/[_\-\s]/g, '');
        return cat.types.some(ct => t === ct || t === ct.replace(/[_\-\s]/g, ''));
      });
    }

    // Tag filter (scary, vibrant visuals)
    if (cat.tagFilter) {
      items = items.filter(i => {
        const tags = i.tags || [];
        return cat.tagFilter.some(tag => tags.includes(tag));
      });
    }

    // Hidden-only filter (Hidden Offers category)
    if (cat.hiddenOnly) {
      items = items.filter(i => i.isHidden);
    }

    // Unfiltered = show EVERYTHING (including hidden) — no filtering at all
    if (cat.includeHidden) {
      // No hidden filter applied below
    }
  }

  // Hidden filter — hide hidden items by default unless:
  //   1. We're on the "Hidden Offers" category
  //   2. We're on the "Unfiltered" category (shows everything)
  //   3. The "Show Hidden" toggle is on
  const skipHiddenFilter = cat && (cat.hiddenOnly || cat.includeHidden);
  if (!skipHiddenFilter && !showHidden) {
    items = items.filter(i => !i.isHidden);
  }

  // Search filter
  if (currentSearch) {
    const q = currentSearch.toLowerCase();
    items = items.filter(i =>
      (i.title || '').toLowerCase().includes(q) ||
      (i.creator || '').toLowerCase().includes(q) ||
      (i.description || '').toLowerCase().includes(q)
    );
  }

  // Sort
  switch (currentSort) {
    case 'rating':
      items = [...items].sort((a, b) => (b.rating || 0) - (a.rating || 0));
      break;
    case 'title':
      items = [...items].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      break;
    default: // newest — already in startDate DESC order from the API
      break;
  }

  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════
const ITEMS_PER_PAGE = 48; // render 48 at a time (infinite scroll)
let renderedCount = 0;
let filteredItems = [];

function renderGrid() {
  filteredItems = getFilteredItems();
  renderedCount = 0;
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  renderMore();
  updateResultCount();
}

function renderMore() {
  const grid = document.getElementById('grid');
  const batch = filteredItems.slice(renderedCount, renderedCount + ITEMS_PER_PAGE);
  if (batch.length === 0) {
    document.getElementById('load-more-container').style.display = 'none';
    return;
  }

  for (const item of batch) {
    grid.appendChild(createItemCard(item));
  }
  renderedCount += batch.length;

  // Show/hide load more button
  const loadMore = document.getElementById('load-more-container');
  if (renderedCount < filteredItems.length) {
    loadMore.style.display = 'flex';
    document.getElementById('load-more-count').textContent = `${renderedCount} / ${filteredItems.length}`;
  } else {
    loadMore.style.display = 'none';
  }
}

function createItemCard(item) {
  const card = document.createElement('a');
  card.className = 'item-card';
  card.href = `#/item/${item.uuid || item.id}`;
  card.onclick = (e) => { e.preventDefault(); navigateToItem(item.uuid || item.id); };

  const img = document.createElement('div');
  img.className = 'item-image';
  const imgUrl = item.image || item.thumbnailUrl || item.packIconUrl || '';
  if (imgUrl) {
    img.style.backgroundImage = `url(${imgUrl})`;
  } else {
    img.innerHTML = '<span class="no-image">?</span>';
  }
  if (item.isHidden) img.classList.add('hidden-badge');
  card.appendChild(img);

  const info = document.createElement('div');
  info.className = 'item-info';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.title || 'Untitled';
  info.appendChild(title);

  const creator = document.createElement('div');
  creator.className = 'item-creator';
  creator.textContent = item.creator || 'Unknown';
  info.appendChild(creator);

  const rating = document.createElement('div');
  rating.className = 'item-rating';
  const stars = item.rating != null ? `★ ${item.rating.toFixed(1)}` : '☆ ☆ ☆ ☆';
  const count = item.ratingCount || item.totalStars || 0;
  rating.innerHTML = `<span class="stars">${stars}</span> ${count > 0 ? `<span class="count">(${count})</span>` : ''}`;
  info.appendChild(rating);

  const typeBadge = document.createElement('div');
  typeBadge.className = 'item-type ' + (item.type || 'dlc');
  typeBadge.textContent = (item.type || 'dlc').toUpperCase();
  info.appendChild(typeBadge);

  card.appendChild(info);
  return card;
}

function updateResultCount() {
  const el = document.getElementById('result-count');
  if (el) {
    el.textContent = `${filteredItems.length.toLocaleString()} item${filteredItems.length !== 1 ? 's' : ''}`;
  }
}

function updateLoadingIndicator() {
  const el = document.getElementById('loading-indicator');
  if (!el) return;
  if (isLoading) {
    el.style.display = 'block';
    el.textContent = `Loading items… ${allItems.length.toLocaleString()} / ${totalItems.toLocaleString()}`;
  } else {
    el.style.display = 'none';
  }
}

function showError(msg) {
  const el = document.getElementById('error-display');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Item detail page
// ═══════════════════════════════════════════════════════════════════════════
async function renderItemDetail(uuid) {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="detail-loading">Loading item…</div>';

  let item = allItems.find(i => (i.uuid || i.id) === uuid);
  if (!item) {
    // Try fetching from API
    const detail = await fetchItemDetail(uuid);
    if (detail) item = detail;
  } else {
    // Fetch full detail for FAQ/how-to
    const detail = await fetchItemDetail(uuid);
    if (detail) item = { ...item, ...detail };
  }

  if (!item) {
    app.innerHTML = '<div class="detail-error">Item not found.</div>';
    return;
  }

  const images = item.images || item.extraImages || [];
  const panorama = item.panoramaImage || item.panoramaUrl || item.imagePanorama || '';
  const videoUrl = item.trailer || item.videoUrl || item.youtubeUrl || '';
  const faq = item.faqEntries || [];
  const howTo = item.howToEntries || [];
  const howToTitle = item.howToTitle || '';

  app.innerHTML = `
    <div class="detail-page">
      <button class="back-btn" onclick="location.hash = '#/'">← Back to Catalog</button>
      <div class="detail-header">
        <div class="detail-thumbnail" style="background-image: url(${item.image || item.thumbnailUrl || item.packIconUrl || ''})"></div>
        <div class="detail-meta">
          <h1 class="detail-title">${item.title || 'Untitled'}</h1>
          <div class="detail-creator">by ${item.creator || 'Unknown'}</div>
          <div class="detail-stats">
            <span class="detail-type ${item.type || 'dlc'}">${(item.type || 'dlc').toUpperCase()}</span>
            ${item.rating != null ? `<span class="detail-rating">★ ${item.rating.toFixed(1)}</span>` : ''}
            ${item.ratingCount ? `<span class="detail-count">${item.ratingCount} ratings</span>` : ''}
            ${item.price != null ? `<span class="detail-price">${item.price === 0 ? 'FREE' : item.price + ' Minecoins'}</span>` : ''}
            ${item.version ? `<span class="detail-version">v${item.version}</span>` : ''}
            ${item.contentSize ? `<span class="detail-size">${formatSize(item.contentSize)}</span>` : ''}
            ${item.isHidden ? '<span class="detail-hidden">HIDDEN</span>' : ''}
          </div>
          <div class="detail-dates">
            ${item.creationDate ? `<span>Created: ${new Date(item.creationDate).toLocaleDateString()}</span>` : ''}
            ${item.lastModifiedDate ? `<span>Updated: ${new Date(item.lastModifiedDate).toLocaleDateString()}</span>` : ''}
          </div>
        </div>
      </div>

      ${panorama ? `<div class="detail-panorama" style="background-image: url(${panorama})"></div>` : ''}

      ${videoUrl ? `<div class="detail-video"><iframe src="${getEmbedUrl(videoUrl)}" frameborder="0" allowfullscreen></iframe></div>` : ''}

      ${images.length > 0 ? `
        <h2 class="detail-section-title">Screenshots</h2>
        <div class="detail-screenshots">
          ${images.map(img => `<div class="screenshot" style="background-image: url(${img})"></div>`).join('')}
        </div>
      ` : ''}

      ${item.description ? `
        <h2 class="detail-section-title">Description</h2>
        <p class="detail-description">${item.description}</p>
      ` : ''}

      ${item.changelog ? `
        <h2 class="detail-section-title">Changelog</h2>
        <p class="detail-changelog">${item.changelog}</p>
      ` : ''}

      ${howToTitle || howTo.length > 0 ? `
        <h2 class="detail-section-title">${howToTitle || 'How to Use'}</h2>
        <div class="detail-howto">
          ${howTo.map(h => `<div class="howto-entry"><h3>${h.heading || ''}</h3><p>${h.content || ''}</p></div>`).join('')}
        </div>
      ` : ''}

      ${faq.length > 0 ? `
        <h2 class="detail-section-title">FAQ</h2>
        <div class="detail-faq">
          ${faq.map(f => `<div class="faq-entry"><h3>${f.heading}</h3><p>${f.content}</p></div>`).join('')}
        </div>
      ` : ''}

      ${(item.downloadUrls || item.cdnUrls || []).length > 0 ? `
        <h2 class="detail-section-title">Download</h2>
        <div class="detail-downloads">
          ${(item.downloadUrls || []).map((url, i) => `<a href="${url}" class="download-link" target="_blank">Download Part ${i + 1}</a>`).join('')}
        </div>
      ` : ''}

      ${(item.tags || []).length > 0 ? `
        <h2 class="detail-section-title">Tags</h2>
        <div class="detail-tags">
          ${(item.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
  window.scrollTo(0, 0);
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb > 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb.toFixed(1) + ' MB';
}

function getEmbedUrl(url) {
  if (!url) return '';
  // Convert YouTube watch URLs to embed URLs
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;
  return url;
}

// ═══════════════════════════════════════════════════════════════════════════
// Routing (hash-based)
// ═══════════════════════════════════════════════════════════════════════════
function handleRoute() {
  const hash = location.hash.slice(1) || '/';

  // Item detail: #/item/<uuid>
  const itemMatch = hash.match(/^\/item\/(.+)$/);
  if (itemMatch) {
    renderItemDetail(itemMatch[1]);
    return;
  }

  // Category: #/category/<cat>
  const catMatch = hash.match(/^\/category\/(.+)$/);
  if (catMatch) {
    currentCategory = catMatch[1];
    updateCategoryTabs();
    renderBrowseView();
    return;
  }

  // Default: browse view (Discover)
  currentCategory = 'discover';
  renderBrowseView();
}

function renderBrowseView() {
  document.getElementById('app').innerHTML = `
    <div class="browse-view">
      <div class="filters-bar">
        <div class="category-tabs" id="category-tabs"></div>
        <div class="search-sort">
          <input type="text" id="search-input" placeholder="Search items…" value="${currentSearch}">
          <select id="sort-select">
            ${SORT_OPTIONS.map(s => `<option value="${s.key}" ${s.key === currentSort ? 'selected' : ''}>${s.label}</option>`).join('')}
          </select>
          <label class="hidden-toggle">
            <input type="checkbox" id="show-hidden" ${showHidden ? 'checked' : ''}>
            <span>Show Hidden</span>
          </label>
        </div>
      </div>
      <div class="result-info">
        <span id="result-count">0 items</span>
        <span id="loading-indicator" style="display:none"></span>
        <span id="error-display" class="error" style="display:none"></span>
      </div>
      <div class="grid" id="grid"></div>
      <div class="load-more-container" id="load-more-container" style="display:none">
        <button class="load-more-btn" onclick="renderMore()">Load More</button>
        <span id="load-more-count"></span>
      </div>
    </div>
  `;

  renderCategoryTabs();
  attachFilterListeners();
  loadAllItems().then(() => renderGrid());
}

function renderCategoryTabs() {
  const container = document.getElementById('category-tabs');
  if (!container) return;
  const mainCats = CATEGORIES.filter(c => c.group === 'main');
  const specialCats = CATEGORIES.filter(c => c.group === 'special');
  container.innerHTML =
    mainCats.map(cat => `
      <button class="cat-tab ${cat.key === currentCategory ? 'active' : ''}" data-cat="${cat.key}">${cat.label}</button>
    `).join('') +
    `<span class="cat-divider"></span>` +
    specialCats.map(cat => `
      <button class="cat-tab special ${cat.key === currentCategory ? 'active' : ''}" data-cat="${cat.key}">${cat.label}</button>
    `).join('');
}

function updateCategoryTabs() {
  document.querySelectorAll('.cat-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.cat === currentCategory);
  });
}

function attachFilterListeners() {
  const search = document.getElementById('search-input');
  if (search) {
    let timer;
    search.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        currentSearch = e.target.value;
        renderGrid();
      }, 300);
    });
  }

  const sort = document.getElementById('sort-select');
  if (sort) {
    sort.addEventListener('change', (e) => {
      currentSort = e.target.value;
      renderGrid();
    });
  }

  const hidden = document.getElementById('show-hidden');
  if (hidden) {
    hidden.addEventListener('change', (e) => {
      showHidden = e.target.checked;
      renderGrid();
    });
  }

  document.querySelectorAll('.cat-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentCategory = btn.dataset.cat;
      updateCategoryTabs();
      location.hash = `#/category/${currentCategory}`;
      renderGrid();
    });
  });
}

function navigateToItem(uuid) {
  location.hash = `#/item/${uuid}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════
window.addEventListener('hashchange', handleRoute);

// Load meta first, then handle route
fetchMeta().then(m => {
  meta = m;
  if (meta) {
    totalItems = meta.totalItems || 0;
    totalPages = meta.totalPages || Math.ceil(totalItems / PAGE_SIZE) || 0;
    const metaEl = document.getElementById('meta-info');
    if (metaEl) {
      metaEl.textContent = `${totalItems.toLocaleString()} items · ${totalPages.toLocaleString()} pages`;
      if (meta.lastFullCrawlAt) {
        metaEl.textContent += ` · crawled ${new Date(meta.lastFullCrawlAt).toLocaleDateString()}`;
      }
    }
  }
  handleRoute();
});
