// app.js
// News Articles List (Vanilla JS)
// ------------------------------------------------------------
// Required functions per spec:
// - loadData()
// - computeFacets()
// - applyFiltersAndSort()
// - paginate()
// - renderControls()
// - renderFacets()
// - renderCards()
// - renderPagination()
// - syncStateToUrl() / readStateFromUrl()
//
// Data flow (high level):
// 1) loadData() fetches articles.json
// 2) normalize dataset + precompute "global" facets (e.g. tag frequency)
// 3) readStateFromUrl() then render controls
// 4) update() runs applyFiltersAndSort() -> paginate() -> render UI
//
// Performance notes:
// - We only render current page cards (10/20/50) rather than the full dataset.
// - Search uses debounce (300ms).
// - Facet counts reflect "available results after other filters" using
//   group-exclusion filtering (common UX pattern for facet counts).

/** @typedef {import("./types").Article} Article */ // (informal; no build step)

const els = {
  articleCount: document.getElementById("articleCount"),
  searchInput: document.getElementById("searchInput"),
  clearSearchBtn: document.getElementById("clearSearchBtn"),
  sortSelect: document.getElementById("sortSelect"),
  pageSizeSelect: document.getElementById("pageSizeSelect"),
  clearFiltersBtn: document.getElementById("clearFiltersBtn"),
  facetsMount: document.getElementById("facetsMount"),
  cardsMount: document.getElementById("cardsMount"),
  paginationMount: document.getElementById("paginationMount"),
  showingText: document.getElementById("showingText"),
  statusText: document.getElementById("statusText"),
  skeletonTemplate: document.getElementById("skeletonTemplate"),
  emptyTemplate: document.getElementById("emptyTemplate"),
  errorTemplate: document.getElementById("errorTemplate"),
};

const TAGS_TOP_N = 18;

const SORTS = {
  newest: "newest",
  oldest: "oldest",
  publisher_az: "publisher_az",
  title_az: "title_az",
};

// App state (synced to URL)
const state = {
  q: "",
  sort: SORTS.newest,
  page: 1,
  pageSize: 20,
  category: new Set(),
  publishers: new Set(),
  languages: new Set(),
  tags: new Set(),
  tagsExpanded: false, // UI-only (not in URL)
};

let allArticles = [];
let normalizedArticles = [];
let globalFacets = {
  categories: new Map(),
  publishers: new Map(),
  languages: new Map(),
  tags: new Map(), // tag -> total count in full dataset
};
let lastResult = {
  filtered: [],
  paged: [],
  total: 0,
  page: 1,
  pageSize: 20,
  totalPages: 1,
};

function debounce(fn, delay = 300) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function safeLower(s) {
  return (s || "").toString().toLowerCase();
}

function parseISODate(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

function humanDate(iso) {
  const ts = parseISODate(iso);
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function getDomain(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function setStatus(text) {
  els.statusText.textContent = text || "";
}

/**
 * Normalize articles for faster filtering (precompute searchable text)
 * @param {any[]} articles
 */
function normalizeArticles(articles) {
  return articles.map((a) => {
    const publisherName = a?.publisher?.name || "";
    const tags = Array.isArray(a?.tags) ? a.tags : [];
    const searchable = [
      a?.title,
      a?.description,
      publisherName,
      tags.join(" "),
    ]
      .filter(Boolean)
      .join(" • ");

    return {
      ...a,
      _publisherName: publisherName,
      _tags: tags,
      _publishedTs: parseISODate(a?.publishedAt),
      _updatedTs: parseISODate(a?.updatedAt),
      _search: safeLower(searchable),
    };
  });
}

/**
 * loadData(): fetches ./articles.json
 */
async function loadData() {
  renderSkeletons(9);

  try {
    const res = await fetch("./articles.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const articles = Array.isArray(json?.articles) ? json.articles : [];
    allArticles = articles;

    normalizedArticles = normalizeArticles(articles);
    globalFacets = computeFacets(normalizedArticles);

    // Update header count badge (total articles)
    els.articleCount.textContent = String(normalizedArticles.length);

    // Restore state from URL + controls
    readStateFromUrl();
    renderControls();

    // Initial render
    update();
  } catch (err) {
    renderError(err);
  }
}

/**
 * computeFacets(): computes global facet counts for dataset (used to render options)
 * @param {any[]} articles
 */
function computeFacets(articles) {
  const categories = new Map();
  const publishers = new Map();
  const languages = new Map();
  const tags = new Map();

  const inc = (map, key) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  };

  for (const a of articles) {
    inc(categories, a?.category || "");
    inc(publishers, a?._publisherName || a?.publisher?.name || "");
    inc(languages, a?.language || "");
    const t = Array.isArray(a?._tags) ? a._tags : [];
    for (const tag of t) inc(tags, tag);
  }

  // Remove empties
  categories.delete("");
  publishers.delete("");
  languages.delete("");

  return { categories, publishers, languages, tags };
}

/**
 * Apply filters (including search) + sorting.
 * Returns the filtered+sorted array (does not paginate).
 */
function applyFiltersAndSort() {
  const q = safeLower(state.q).trim();
  const hasQ = q.length > 0;

  const selected = {
    category: state.category,
    publishers: state.publishers,
    languages: state.languages,
    tags: state.tags,
  };

  const filtered = normalizedArticles.filter((a) => {
    if (hasQ && !a._search.includes(q)) return false;

    if (selected.category.size && !selected.category.has(a.category)) return false;
    if (selected.publishers.size && !selected.publishers.has(a._publisherName)) return false;
    if (selected.languages.size && !selected.languages.has(a.language)) return false;

    if (selected.tags.size) {
      const tags = Array.isArray(a._tags) ? a._tags : [];
      let ok = false;
      for (const t of tags) {
        if (selected.tags.has(t)) { ok = true; break; }
      }
      if (!ok) return false;
    }

    return true;
  });

  // Sorting
  const sorted = filtered.slice();
  switch (state.sort) {
    case SORTS.oldest:
      sorted.sort((a, b) => (a._publishedTs || 0) - (b._publishedTs || 0));
      break;
    case SORTS.publisher_az:
      sorted.sort((a, b) => safeLower(a._publisherName).localeCompare(safeLower(b._publisherName)) || safeLower(a.title).localeCompare(safeLower(b.title)));
      break;
    case SORTS.title_az:
      sorted.sort((a, b) => safeLower(a.title).localeCompare(safeLower(b.title)) || (b._publishedTs || 0) - (a._publishedTs || 0));
      break;
    case SORTS.newest:
    default:
      sorted.sort((a, b) => (b._publishedTs || 0) - (a._publishedTs || 0));
      break;
  }

  return sorted;
}

/**
 * paginate(): slices a list based on state.page + state.pageSize
 * @param {any[]} list
 */
function paginate(list) {
  const total = list.length;
  const pageSize = state.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = clamp(state.page, 1, totalPages);

  const startIdx = (page - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);

  return {
    total,
    page,
    pageSize,
    totalPages,
    startIdx,
    endIdx,
    pageItems: list.slice(startIdx, endIdx),
  };
}

/**
 * Compute "dynamic facet counts" for each group:
 * counts reflect results after all filters EXCEPT the group itself.
 */
function computeDynamicFacetCounts() {
  const q = safeLower(state.q).trim();
  const hasQ = q.length > 0;

  // Helper: filter with some groups excluded
  const filterWithExclusions = (excludeGroup) => {
    return normalizedArticles.filter((a) => {
      if (hasQ && !a._search.includes(q)) return false;

      if (excludeGroup !== "category" && state.category.size && !state.category.has(a.category)) return false;
      if (excludeGroup !== "publishers" && state.publishers.size && !state.publishers.has(a._publisherName)) return false;
      if (excludeGroup !== "languages" && state.languages.size && !state.languages.has(a.language)) return false;

      if (excludeGroup !== "tags" && state.tags.size) {
        const tags = Array.isArray(a._tags) ? a._tags : [];
        let ok = false;
        for (const t of tags) {
          if (state.tags.has(t)) { ok = true; break; }
        }
        if (!ok) return false;
      }

      return true;
    });
  };

  const groups = ["category", "publishers", "languages", "tags"];
  const out = {};

  for (const g of groups) {
    const base = filterWithExclusions(g);
    const map = new Map();

    const inc = (k) => {
      if (!k) return;
      map.set(k, (map.get(k) || 0) + 1);
    };

    for (const a of base) {
      if (g === "category") inc(a.category);
      if (g === "publishers") inc(a._publisherName);
      if (g === "languages") inc(a.language);
      if (g === "tags") {
        const t = Array.isArray(a._tags) ? a._tags : [];
        for (const tag of t) inc(tag);
      }
    }

    map.delete("");
    out[g] = map;
  }

  return out;
}

/**
 * renderControls(): wires up controls + sets values
 */
function renderControls() {
  // Set initial values
  els.searchInput.value = state.q || "";
  els.sortSelect.value = state.sort;
  els.pageSizeSelect.value = String(state.pageSize);

  // Search (debounced)
  els.searchInput.addEventListener("input", debounce(() => {
    state.q = els.searchInput.value;
    state.page = 1;
    syncStateToUrl();
    update();
  }, 320));

  // Clear search icon
  els.clearSearchBtn.addEventListener("click", () => {
    els.searchInput.value = "";
    state.q = "";
    state.page = 1;
    syncStateToUrl();
    update();
    els.searchInput.focus();
  });

  // Sort
  els.sortSelect.addEventListener("change", () => {
    state.sort = els.sortSelect.value;
    state.page = 1;
    syncStateToUrl();
    update();
  });

  // Page size
  els.pageSizeSelect.addEventListener("change", () => {
    state.pageSize = Number(els.pageSizeSelect.value) || 20;
    state.page = 1;
    syncStateToUrl();
    update();
  });

  // Clear filters
  els.clearFiltersBtn.addEventListener("click", () => clearAllFilters());
}

/**
 * renderFacets(): creates facet UI from global facets + dynamic counts
 */
function renderFacets(dynamicCounts) {
  const mount = els.facetsMount;
  mount.innerHTML = "";

  const facets = [
    {
      key: "category",
      title: "Category",
      selected: state.category,
      allOptions: globalFacets.categories,
      counts: dynamicCounts.category,
      onToggle: (v) => toggleMulti(state.category, v),
      allLabel: "All categories",
    },
    {
      key: "publishers",
      title: "Publisher",
      selected: state.publishers,
      allOptions: globalFacets.publishers,
      counts: dynamicCounts.publishers,
      onToggle: (v) => toggleMulti(state.publishers, v),
      allLabel: "All publishers",
    },
    {
      key: "languages",
      title: "Language",
      selected: state.languages,
      allOptions: globalFacets.languages,
      counts: dynamicCounts.languages,
      onToggle: (v) => toggleMulti(state.languages, v),
      allLabel: "All languages",
    },
    {
      key: "tags",
      title: "Tags",
      selected: state.tags,
      allOptions: globalFacets.tags,
      counts: dynamicCounts.tags,
      onToggle: (v) => toggleMulti(state.tags, v),
      allLabel: "All tags",
      isTags: true,
    },
  ];

  const frag = document.createDocumentFragment();

  for (const f of facets) {
    const card = document.createElement("div");
    card.className = "facet";

    const details = document.createElement("details");
    details.open = window.matchMedia("(min-width: 900px)").matches; // expanded on desktop
    details.setAttribute("data-facet", f.key);

    const summary = document.createElement("summary");
    summary.setAttribute("aria-label", `${f.title} filter group`);
    const left = document.createElement("div");
    left.className = "facet-title";
    left.innerHTML = `<span>${f.title}</span> <span class="small">${f.selected.size ? `${f.selected.size} selected` : "All"}</span>`;
    const caret = document.createElement("span");
    caret.className = "small";
    caret.textContent = details.open ? "Hide" : "Show";
    summary.append(left, caret);

    details.addEventListener("toggle", () => {
      caret.textContent = details.open ? "Hide" : "Show";
    });

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", `${f.title} filters`);

    // All chip
    const allChip = makeChip("All", f.selected.size === 0, () => {
      f.selected.clear();
      state.page = 1;
      syncStateToUrl();
      update();
    }, f.allLabel, true);
    chips.appendChild(allChip);

    // Options, sorted by count desc then label
    let options = Array.from(f.allOptions.entries())
      .map(([label, totalCount]) => ({ label, totalCount }))
      .filter((x) => x.label);

    if (f.isTags) {
      // Sort tags by global frequency, then show top N by default
      options.sort((a, b) => (b.totalCount - a.totalCount) || a.label.localeCompare(b.label));
      const shown = state.tagsExpanded ? options : options.slice(0, TAGS_TOP_N);
      appendOptionChips(chips, shown, f);

      if (options.length > TAGS_TOP_N) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "chip";
        more.setAttribute("aria-pressed", String(state.tagsExpanded));
        more.textContent = state.tagsExpanded ? "Less…" : "More…";
        more.addEventListener("click", () => {
          state.tagsExpanded = !state.tagsExpanded;
          // UI-only toggle; no URL sync needed
          update({ skipUrl: true });
        });
        chips.appendChild(more);
      }
    } else {
      options.sort((a, b) => a.label.localeCompare(b.label));
      appendOptionChips(chips, options, f);
    }

    details.append(summary, chips);
    card.appendChild(details);
    frag.appendChild(card);
  }

  mount.appendChild(frag);

  function appendOptionChips(chipsEl, optionsArr, facet) {
    for (const opt of optionsArr) {
      const dynamicCount = facet.counts.get(opt.label) || 0;
      const isActive = facet.selected.has(opt.label);

      const chip = makeChip(
        opt.label,
        isActive,
        () => {
          facet.onToggle(opt.label);
          state.page = 1;
          syncStateToUrl();
          update();
        },
        `${facet.title} ${opt.label} (${dynamicCount})`,
        false,
        dynamicCount
      );

      // If count is 0 and not active, disable (keeps UI honest)
      if (dynamicCount === 0 && !isActive) {
        chip.style.opacity = "0.55";
        chip.style.cursor = "not-allowed";
        chip.addEventListener("click", (e) => e.preventDefault());
      }

      chipsEl.appendChild(chip);
    }
  }
}

function makeChip(label, active, onClick, ariaLabel, isAll = false, count = null) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.setAttribute("aria-pressed", String(active));
  b.setAttribute("aria-label", ariaLabel || label);

  const text = document.createElement("span");
  text.textContent = label;

  b.appendChild(text);

  if (!isAll && typeof count === "number") {
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = String(count);
    b.appendChild(c);
  }

  b.addEventListener("click", onClick);
  return b;
}

function toggleMulti(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

/**
 * renderCards(): renders current page items
 * @param {any[]} pageItems
 */
function renderCards(pageItems) {
  const mount = els.cardsMount;
  mount.innerHTML = "";

  if (!pageItems.length) return;

  const frag = document.createDocumentFragment();

  for (const a of pageItems) {
    frag.appendChild(renderCard(a));
  }

  mount.appendChild(frag);
}

function renderCard(a) {
  const card = document.createElement("article");
  card.className = "card";
  card.tabIndex = 0;
  card.setAttribute("role", "article");
  card.setAttribute("aria-label", a?.title || "Article");

  // Thumbnail
  const img = document.createElement("img");
  img.className = "thumb";
  img.alt = a?.title ? `Thumbnail for ${a.title}` : "Article thumbnail";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.src = a?.imageUrl || makePlaceholderDataUri();

  img.addEventListener("error", () => {
    img.src = makePlaceholderDataUri();
  });

  // Body
  const body = document.createElement("div");
  body.className = "card-body";

  // Title (link)
  const h3 = document.createElement("h3");
  h3.className = "card-title";
  const titleLink = document.createElement("a");
  titleLink.href = a?.url || "#";
  titleLink.target = "_blank";
  titleLink.rel = "noopener noreferrer";
  titleLink.textContent = a?.title || "Untitled article";
  h3.appendChild(titleLink);

  // Meta row: publisher + author + dates + reading time
  const meta = document.createElement("div");
  meta.className = "meta-row";

  const publisherWrap = document.createElement("span");
  publisherWrap.className = "publisher";

  if (a?.publisher?.logoUrl) {
    const logo = document.createElement("img");
    logo.className = "publisher-logo";
    logo.alt = `${a.publisher.name || "Publisher"} logo`;
    logo.loading = "lazy";
    logo.decoding = "async";
    logo.referrerPolicy = "no-referrer";
    logo.src = a.publisher.logoUrl;
    logo.addEventListener("error", () => logo.remove());
    publisherWrap.appendChild(logo);
  }

  const pubName = a?._publisherName || a?.publisher?.name || "Unknown publisher";
  if (a?.publisher?.url) {
    const pubLink = document.createElement("a");
    pubLink.href = a.publisher.url;
    pubLink.target = "_blank";
    pubLink.rel = "noopener noreferrer";
    pubLink.textContent = pubName;
    publisherWrap.appendChild(pubLink);
  } else {
    const span = document.createElement("span");
    span.textContent = pubName;
    publisherWrap.appendChild(span);
  }

  meta.appendChild(publisherWrap);

  if (a?.author) {
    const author = document.createElement("span");
    author.textContent = `• ${a.author}`;
    meta.appendChild(author);
  }

  const pubDate = humanDate(a?.publishedAt);
  if (pubDate) {
    const d = document.createElement("span");
    d.textContent = `• ${pubDate}`;
    meta.appendChild(d);
  }

  const updDate = humanDate(a?.updatedAt);
  if (updDate) {
    const u = document.createElement("span");
    u.textContent = `• Updated ${updDate}`;
    meta.appendChild(u);
  }

  if (Number.isFinite(a?.readingTimeMinutes)) {
    const rt = document.createElement("span");
    rt.textContent = `• ${a.readingTimeMinutes} min read`;
    meta.appendChild(rt);
  }

  // Badges: category + language + country
  const badges = document.createElement("div");
  badges.className = "badges";
  const addBadge = (t) => {
    if (!t) return;
    const b = document.createElement("span");
    b.className = "badge";
    b.textContent = t;
    badges.appendChild(b);
  };
  addBadge(a?.category);
  addBadge(a?.language);
  addBadge(a?.country);

  // Description
  const desc = document.createElement("p");
  desc.className = "desc";
  desc.textContent = a?.description || "No description available.";

  // Tags chips (click toggles tag facet)
  const tagRow = document.createElement("div");
  tagRow.className = "tag-chips";
  const tags = Array.isArray(a?._tags) ? a._tags : [];
  for (const t of tags.slice(0, 10)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-chip";
    chip.setAttribute("aria-pressed", String(state.tags.has(t)));
    chip.setAttribute("aria-label", `Toggle tag filter: ${t}`);
    chip.textContent = `#${t}`;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMulti(state.tags, t);
      state.page = 1;
      syncStateToUrl();
      update();
    });
    tagRow.appendChild(chip);
  }

  // Footer: domain + share
  const footer = document.createElement("div");
  footer.className = "card-footer";

  const left = document.createElement("span");
  const domain = getDomain(a?.url || "");
  left.textContent = domain ? domain : "—";

  const share = document.createElement("button");
  share.type = "button";
  share.className = "share-btn";
  share.textContent = "Share";
  share.setAttribute("aria-label", `Copy link for: ${a?.title || "article"}`);
  share.addEventListener("click", async (e) => {
    e.stopPropagation();
    const url = a?.url || "";
    if (!url) return;

    try {
      await navigator.clipboard.writeText(url);
      setStatus("Copied link to clipboard");
      setTimeout(() => setStatus(""), 1200);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setStatus("Copied link to clipboard");
      setTimeout(() => setStatus(""), 1200);
    }
  });

  footer.append(left, share);

  body.append(h3, meta, badges, desc, tagRow, footer);

  // Entire card clickable (except interactive controls)
  card.addEventListener("click", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const tag = target?.tagName?.toLowerCase();
    const isInteractive = ["a", "button", "input", "select", "textarea"].includes(tag);
    if (isInteractive) return;

    if (a?.url) window.open(a.url, "_blank", "noopener,noreferrer");
  });

  // Keyboard open
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const active = document.activeElement;
      // If focused inside a link/button, let default happen
      if (active && ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
      if (a?.url) window.open(a.url, "_blank", "noopener,noreferrer");
    }
  });

  card.append(img, body);
  return card;
}

function makePlaceholderDataUri() {
  // Tiny inline SVG placeholder (no network dependency)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675">
      <defs>
        <linearGradient id="g" x1="0" x2="1">
          <stop offset="0" stop-color="rgba(255,255,255,0.06)"/>
          <stop offset="1" stop-color="rgba(255,255,255,0.10)"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="675" fill="url(#g)"/>
      <g fill="rgba(255,255,255,0.18)">
        <rect x="90" y="110" width="520" height="44" rx="12"/>
        <rect x="90" y="180" width="700" height="26" rx="10"/>
        <rect x="90" y="230" width="640" height="26" rx="10"/>
        <rect x="90" y="300" width="480" height="22" rx="10"/>
        <circle cx="1030" cy="510" r="70" />
        <rect x="760" y="420" width="350" height="26" rx="10"/>
      </g>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * renderPagination(): numbered buttons with ellipsis + optional jump
 */
function renderPagination(totalPages, currentPage) {
  const mount = els.paginationMount;
  mount.innerHTML = "";

  if (totalPages <= 1) return;

  const frag = document.createDocumentFragment();

  const prev = document.createElement("button");
  prev.className = "page-btn";
  prev.textContent = "Prev";
  prev.disabled = currentPage <= 1;
  prev.setAttribute("aria-label", "Previous page");
  prev.addEventListener("click", () => goToPage(currentPage - 1));
  frag.appendChild(prev);

  const pages = makePageModel(totalPages, currentPage);

  for (const p of pages) {
    if (p === "...") {
      const el = document.createElement("span");
      el.className = "ellipsis";
      el.textContent = "…";
      frag.appendChild(el);
      continue;
    }
    const b = document.createElement("button");
    b.className = "page-btn";
    b.textContent = String(p);
    b.setAttribute("aria-label", `Go to page ${p}`);
    if (p === currentPage) b.setAttribute("aria-current", "page");
    b.addEventListener("click", () => goToPage(p));
    frag.appendChild(b);
  }

  const next = document.createElement("button");
  next.className = "page-btn";
  next.textContent = "Next";
  next.disabled = currentPage >= totalPages;
  next.setAttribute("aria-label", "Next page");
  next.addEventListener("click", () => goToPage(currentPage + 1));
  frag.appendChild(next);

  // Optional jump-to-page
  const jump = document.createElement("div");
  jump.className = "jump";
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = "Jump:";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = String(totalPages);
  input.placeholder = String(currentPage);
  input.setAttribute("aria-label", "Jump to page number");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const n = Number(input.value);
      if (Number.isFinite(n)) goToPage(clamp(n, 1, totalPages));
    }
  });
  jump.append(label, input);
  frag.appendChild(jump);

  mount.appendChild(frag);
}

function makePageModel(totalPages, current) {
  // Example: 1 2 3 … 10
  // Keep a window around current, always show first/last.
  const windowSize = 2;
  const pages = new Set([1, totalPages]);

  for (let i = current - windowSize; i <= current + windowSize; i++) {
    if (i >= 1 && i <= totalPages) pages.add(i);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    const next = sorted[i + 1];
    if (next && next - sorted[i] > 1) out.push("...");
  }
  return out;
}

function goToPage(p) {
  state.page = p;
  syncStateToUrl();
  update();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/**
 * syncStateToUrl(): writes state to query params
 */
function syncStateToUrl() {
  const params = new URLSearchParams(window.location.search);

  const setOrDelete = (k, v) => {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) params.delete(k);
    else params.set(k, v);
  };

  setOrDelete("q", state.q?.trim() || "");
  setOrDelete("sort", state.sort);
  setOrDelete("page", String(state.page));
  setOrDelete("pageSize", String(state.pageSize));

  setOrDelete("category", Array.from(state.category).join(","));
  setOrDelete("publishers", Array.from(state.publishers).join(","));
  setOrDelete("languages", Array.from(state.languages).join(","));
  setOrDelete("tags", Array.from(state.tags).join(","));

  const newUrl = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", newUrl);
}

/**
 * readStateFromUrl(): reads query params on load
 */
function readStateFromUrl() {
  const params = new URLSearchParams(window.location.search);

  const q = params.get("q");
  const sort = params.get("sort");
  const page = Number(params.get("page"));
  const pageSize = Number(params.get("pageSize"));

  state.q = q ?? "";
  if (Object.values(SORTS).includes(sort)) state.sort = sort;
  state.page = Number.isFinite(page) && page > 0 ? page : 1;
  state.pageSize = [10, 20, 50].includes(pageSize) ? pageSize : state.pageSize;

  const parseSet = (key) => {
    const raw = params.get(key);
    const set = new Set();
    if (!raw) return set;
    raw.split(",").map(s => s.trim()).filter(Boolean).forEach(v => set.add(v));
    return set;
  };

  state.category = parseSet("category");
  state.publishers = parseSet("publishers");
  state.languages = parseSet("languages");
  state.tags = parseSet("tags");
}

function clearAllFilters() {
  state.q = "";
  state.page = 1;
  state.sort = SORTS.newest;
  state.pageSize = 20;

  state.category.clear();
  state.publishers.clear();
  state.languages.clear();
  state.tags.clear();
  state.tagsExpanded = false;

  // Sync control UI
  els.searchInput.value = "";
  els.sortSelect.value = state.sort;
  els.pageSizeSelect.value = String(state.pageSize);

  syncStateToUrl();
  update();
}

function renderSkeletons(count = 9) {
  els.cardsMount.innerHTML = "";
  els.paginationMount.innerHTML = "";
  els.showingText.textContent = "";
  setStatus("Loading…");

  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const node = els.skeletonTemplate.content.cloneNode(true);
    frag.appendChild(node);
  }
  els.cardsMount.appendChild(frag);
}

function renderEmpty() {
  els.cardsMount.innerHTML = "";
  els.paginationMount.innerHTML = "";
  const node = els.emptyTemplate.content.cloneNode(true);
  els.cardsMount.appendChild(node);

  const btn = document.getElementById("emptyClearBtn");
  btn?.addEventListener("click", () => clearAllFilters());
}

function renderError(err) {
  console.error(err);
  els.cardsMount.innerHTML = "";
  els.paginationMount.innerHTML = "";
  els.showingText.textContent = "";
  setStatus("");

  const node = els.errorTemplate.content.cloneNode(true);
  els.cardsMount.appendChild(node);

  const btn = document.getElementById("retryBtn");
  btn?.addEventListener("click", () => loadData());
}

/**
 * update(): the main re-render pipeline
 * @param {{skipUrl?: boolean}} opts
 */
function update(opts = {}) {
  if (!opts.skipUrl) syncStateToUrl();

  const filtered = applyFiltersAndSort();
  const pageInfo = paginate(filtered);

  // Keep state.page clamped
  state.page = pageInfo.page;

  lastResult = {
    filtered,
    paged: pageInfo.pageItems,
    total: pageInfo.total,
    page: pageInfo.page,
    pageSize: pageInfo.pageSize,
    totalPages: pageInfo.totalPages,
  };

  // Dynamic facet counts
  const dyn = computeDynamicFacetCounts();
  renderFacets(dyn);

  // Showing text
  if (pageInfo.total === 0) {
    els.showingText.textContent = "Showing 0 results";
  } else {
    els.showingText.textContent = `Showing ${pageInfo.startIdx + 1}–${pageInfo.endIdx} of ${pageInfo.total}`;
  }

  // Status
  setStatus("");

  // Cards + pagination
  if (pageInfo.total === 0) {
    renderEmpty();
  } else {
    renderCards(pageInfo.pageItems);
    renderPagination(pageInfo.totalPages, pageInfo.page);
  }

  // Keep controls in sync (important after URL restore / clear)
  // (Avoid stomping cursor position while typing—only safe updates)
  els.sortSelect.value = state.sort;
  els.pageSizeSelect.value = String(state.pageSize);
}

document.addEventListener("DOMContentLoaded", () => {
  loadData();
});
