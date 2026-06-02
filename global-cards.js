// min-width:0 is the canonical CSS Grid fix: without it the grid track expands
// to fit the shadow host's min-content width instead of its assigned track size.
// overflow:visible lets inline sections extend beyond the element boundary when
// the source section is wider than the containing grid cell.
const HOST_STYLE = ':host { display: block; width: 100%; min-width: 0; overflow: visible; box-sizing: border-box; }';

const BADGE_STYLE = `
  position: absolute; top: 4px; right: 4px;
  padding: 2px 8px; border-radius: 8px;
  background: #1a1a2e; border: 1px solid #4caf50;
  color: #4caf50; font-size: 11px; font-family: monospace;
  z-index: 1; pointer-events: none;
`;

const POPUP_HIDDEN_STYLE = `
  position: fixed !important;
  top: 0 !important; left: 0 !important;
  width: 0 !important; height: 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
`;

const SECTION_GRID_STYLE = `
  width: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--masonry-view-card-margin, 8px);
  align-content: start;
`;

const SECTION_FLEX_STYLE = `
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  gap: var(--masonry-view-card-margin, 8px);
`;

const FLAT_CONTAINER_STYLE = `
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--masonry-view-card-margin, 8px);
`;

// Removes popup containers when the user navigates to the source dashboard/view
// to prevent Bubble Card from registering the same hashes twice.

const _registry = new Map(); // cacheKey → { container, sourceDashboard, sourceView }

let _lastPathname = window.location.pathname;

function _handleNavigation() {
  const pathname = window.location.pathname;

  // Ignore pure hash changes (e.g. Bubble Card popup activation via #hash).
  // Only act on actual page/view navigations.
  if (pathname === _lastPathname) return;
  _lastPathname = pathname;

  for (const entry of _registry.values()) {
    // Match the exact source path so dashboards whose url_path is a substring
    // of another (e.g. "lovelace" vs "lovelace/main") don't cause false positives.
    const sourcePath = entry.sourceView
      ? `/${entry.sourceDashboard}/${entry.sourceView}`
      : `/${entry.sourceDashboard}`;

    const onSource = pathname === sourcePath || pathname.startsWith(sourcePath + '/');

    if (onSource && entry.container.isConnected) {
      entry.container.remove();
    }
  }
}

window.addEventListener('location-changed', _handleNavigation);
window.addEventListener('popstate', _handleNavigation);

function registerPopupContainer(key, container, sourceDashboard, sourceView) {
  _registry.set(key, { container, sourceDashboard, sourceView });
}

function unregisterPopupContainer(key) {
  const entry = _registry.get(key);
  if (entry) {
    entry.container.remove();
    _registry.delete(key);
  }
}

// ── Config cache ─────────────────────────────────────────────────────────────
const _configCache = new Map();
const CONFIG_CACHE_TTL = 60_000;

// ── Sections-width cache ─────────────────────────────────────────────────────
// Populated whenever we successfully measure a live hui-sections-view wrapper.
// Survives navigation to other views (masonry, grid, etc.) so that global-cards
// on non-sections views can still render at the correct source-dashboard card size.
let _lastKnownSectionsWidth = 0;

// The CSS max-width of the sections-view wrapper content area, cached the first
// time strategy 1 succeeds.  Used to cap strategy-3's hui-root estimate so we
// don't overestimate at large viewports where the wrapper hits its max-width.
// Typical value: 1564 px (HA 2024+).  0 = not yet measured.
let _sectionsContentMaxWidth = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function cacheKey(config) {
  return `${config.source_dashboard}::${config.source_view || ''}`;
}

function findAppendTarget() {
  try {
    const huiRoot = document.querySelector('home-assistant')
      ?.shadowRoot?.querySelector('home-assistant-main')
      ?.shadowRoot?.querySelector('ha-drawer')
      ?.querySelector('partial-panel-resolver ha-panel-lovelace')
      ?.shadowRoot?.querySelector('hui-root');
    return huiRoot?.shadowRoot ?? document.body;
  } catch {
    return document.body;
  }
}

function findExistingContainer(appendTarget, key) {
  try {
    return appendTarget?.querySelector(`[data-global-cards-key="${key}"]`) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a stub lovelace object that hui-section / hui-grid-section require in
 * order to render.  All keys that HA's real lovelace object exposes must be
 * present or the section will silently render empty.
 */
function buildLovelace(hass, lovelaceConfig, urlPath) {
  return {
    config: lovelaceConfig,
    rawConfig: lovelaceConfig,       // required by hui-grid-section
    editMode: false,
    mode: 'storage',
    urlPath: urlPath || '',          // required by hui-grid-section
    locale: hass.locale,
    enableFullEditMode: () => {},
    setEditMode: () => {},           // required by hui-grid-section
    saveConfig: async () => {},
    deleteConfig: async () => {},
    showToast: () => {},
  };
}

function extractStructure(lovelaceConfig, config) {
  const views = lovelaceConfig.views || [];
  const { source_view } = config;

  let targetViews;
  if (source_view) {
    const view = views.find(v => v.path === source_view || v.title === source_view);
    targetViews = view ? [view] : [];
  } else {
    targetViews = views;
  }

  const hasSections = targetViews.some(v => v.sections?.length);

  if (hasSections) {
    return {
      type: 'sections',
      maxColumns: targetViews[0]?.max_columns || 4,
      sections: targetViews.flatMap(v => v.sections || []),
    };
  }

  return {
    type: 'flat',
    cards: targetViews.flatMap(v => v.cards || []),
  };
}

async function fetchLovelaceConfig(hass, config) {
  const key = cacheKey(config);
  const cached = _configCache.get(key);
  if (cached && Date.now() - cached.ts < CONFIG_CACHE_TTL) {
    return cached.config;
  }
  const result = await hass.callWS({
    type: 'lovelace/config',
    url_path: config.source_dashboard,
  });
  _configCache.set(key, { config: result, ts: Date.now() });
  return result;
}

// ── Sections natural-width helper ────────────────────────────────────────────

/** Measure a single hui-sections-view's content-area width (wrapper box minus padding). */
function _measureSectionsWrapper(sv) {
  if (!sv) return 0;
  try {
    const wrapper = sv.shadowRoot?.querySelector?.('.wrapper');
    if (!wrapper) return 0;
    const wRect = wrapper.getBoundingClientRect();
    if (wRect.width <= 0) return 0;
    const wStyle = getComputedStyle(wrapper);
    const padH = (parseFloat(wStyle.paddingLeft) || 0) +
                 (parseFloat(wStyle.paddingRight) || 0);
    const contentWidth = Math.max(wRect.width - padH, 200);

    // Cache the wrapper's CSS max-width (content-box) so strategy 3 can cap its
    // hui-root estimate at the same value when no live sections-view is present.
    // getComputedStyle returns the *used* max-width (e.g. "1564px"), which equals
    // the content-box limit for box-sizing:content-box wrappers.
    const maxWPx = parseFloat(wStyle.maxWidth);
    if (maxWPx > 0 && maxWPx < 10_000) _sectionsContentMaxWidth = maxWPx;

    return contentWidth;
  } catch {
    return 0;
  }
}

/**
 * Return the content-area width of the sections-view layout on this device.
 * Used to pin injected sections to the same card sizes as the source dashboard.
 *
 * Strategy:
 *  0. config.section_width — explicit pixel override, skips all auto-detection.
 *  1. Live measurement from the currently active hui-sections-view, or any
 *     hui-sections-view still in the DOM (HA sometimes keeps prior views
 *     attached during navigation transitions).  Result is cached.
 *  2. Module-level cache from a previous successful live measurement.
 *     This is the key fix for the sidebar-mismatch case: when the source
 *     sections-view was last visited (possibly in another browser tab or after
 *     a navigation), its width is remembered and reused here on non-sections
 *     views where the sidebar may have a different width.
 *  3. Last resort: hui-root width directly.  Inaccurate when the sidebar is
 *     wider on the current view than it was on the source sections-view, but
 *     better than returning 0.
 */
function getSectionsNaturalWidth(config) {
  // 0. Explicit user override
  const override = config?.section_width;
  if (override > 0) return override;

  try {
    const appendTarget = findAppendTarget();
    const huiRootEl = appendTarget?.host;
    if (!huiRootEl) return _lastKnownSectionsWidth || 0;

    // 1. Try to measure from any live hui-sections-view.
    //    First check the active view; then scan the full document in case HA
    //    keeps an inactive sections-view mounted during/after navigation.
    let measured = 0;

    const huiRootSR = huiRootEl.shadowRoot;
    const huiView = huiRootSR?.querySelector('hui-view');
    if (huiView) {
      const sv =
        huiView.querySelector?.('hui-sections-view') ??
        huiView.shadowRoot?.querySelector?.('hui-sections-view');
      measured = _measureSectionsWrapper(sv);
    }

    if (!measured) {
      for (const sv of document.querySelectorAll('hui-sections-view')) {
        measured = _measureSectionsWrapper(sv);
        if (measured) break;
      }
    }

    if (measured) {
      _lastKnownSectionsWidth = measured;  // persist for future non-sections views
      return measured;
    }

    // 2. Use cached width from a previous sections-view visit.
    if (_lastKnownSectionsWidth > 0) return _lastKnownSectionsWidth;

    // 3. Last resort: hui-root width minus the sections-view wrapper padding.
    //    We only use this if strategy 1 has previously run and cached the wrapper's
    //    CSS max-width (_sectionsContentMaxWidth > 0).  Without that baseline,
    //    the estimate overestimates by ~234 px on large viewports (the wrapper is
    //    capped at max-width while hui-root keeps growing), producing cards that
    //    overflow their container.  Returning 0 here instead causes the section to
    //    fill the container at its natural width — no clipping, slightly different
    //    size from source but much better UX on first load.
    if (_sectionsContentMaxWidth > 0) {
      const SECTIONS_PADDING_EST = 64;
      const rootW = huiRootEl.getBoundingClientRect().width;
      if (rootW <= 0) return 0;
      const raw = Math.max(rootW - SECTIONS_PADDING_EST, 200);
      return Math.min(raw, _sectionsContentMaxWidth);
    }
    return 0;   // no reliable estimate — caller will use width:100%
  } catch {
    return _lastKnownSectionsWidth || 0;
  }
}

/**
 * Deferred width correction for the inner section wrapper(s).
 *
 * Problem: hui-root may not exist in the DOM yet when global-cards first
 * renders (early page load), so getSectionsNaturalWidth() returns 0 and the
 * inner div gets no fixed width.  Even if hui-root is present, the sidebar
 * may still be animating so its width reading is premature.
 *
 * Solution: poll every 50 ms until hui-root is found, then attach a
 * ResizeObserver.  Once the layout is stable (150 ms of no resize events),
 * read the settled width and pin the inner div(s) to the correct value.
 * Only runs when no explicit section_width override is configured.
 */
function _updateWidthOnSettle(innerDivs, config, colSpans, columnCount) {
  if (!innerDivs.length) return;

  let done = false;
  let debounce = null;
  let ro = null;

  const apply = () => {
    if (done) return;
    const w = getSectionsNaturalWidth(config);
    if (w <= 0) return;   // not ready — leave done=false so we can retry

    done = true;
    ro?.disconnect();
    clearTimeout(debounce);

    innerDivs.forEach((div, i) => {
      if (!div) return;
      const span = colSpans[i] ?? 1;
      const newW = Math.round(w * span / columnCount);
      // Read current value from whichever property is in use.
      const curW = parseFloat(div.style.maxWidth)
        || parseFloat(div.style.width)
        || parseFloat(div.style.flexBasis)
        || 0;
      if (Math.abs(newW - curW) > 4) {
        if (div.style.flexBasis) {
          // Multi-section elements use flex shorthand.
          div.style.flexBasis = `${newW}px`;
        } else {
          // Single-section inner wrapper uses max-width so it fills narrower
          // containers instead of overflowing them.
          div.style.maxWidth = `${newW}px`;
        }
      }
    });
  };

  // Poll until hui-root appears in the DOM, then watch it for size stability.
  const setup = () => {
    if (done) return;
    const appendTarget = findAppendTarget();
    const huiRootEl = appendTarget?.host;

    if (!huiRootEl) {
      // hui-root not in DOM yet — retry shortly
      setTimeout(setup, 50);
      return;
    }

    // hui-root found — observe it and also fire once immediately
    ro = new ResizeObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(apply, 150);
    });
    ro.observe(huiRootEl);

    // Trigger an initial attempt after the first layout cycle
    debounce = setTimeout(apply, 150);

    // Hard safety cap: give up after 5 s whether or not we succeeded
    setTimeout(() => { done = true; ro?.disconnect(); }, 5000);
  };

  setTimeout(setup, 0); // start on the next tick so the caller's sync code finishes first
}

// ── Inline sections ───────────────────────────────────────────────────────────

async function buildInlineSections(structure, hass, helpers, container, lovelaceConfig, urlPath, config) {
  const useHuiSection = !!customElements.get('hui-section');
  const lovelace = buildLovelace(hass, lovelaceConfig, urlPath);
  const cards = [];
  let cardCount = 0;

  // Always use the SOURCE view's max_columns for both the CSS variables and
  // the pixel-width calculation.  The current page may be a sections-view with
  // a different column count — using its --column-count would give wrong sizes.
  const columnCount = structure.maxColumns;

  // Always compute the natural content-area width of a sections-view on this
  // device, regardless of what view we're currently on.  This value caps card
  // sizes so they are never wider than they would be on the source dashboard,
  // but still allow shrinking on narrow / mobile screens (via max-width, not
  // a fixed width).
  const naturalWidth = getSectionsNaturalWidth(config);

  if (structure.sections.length === 1) {
    const section = structure.sections[0];
    const sectionColumnSpan = section.column_span || 1;

    // A single section ALWAYS fills the full content area of the sections-view
    // wrapper, regardless of column_span.  HA achieves this by spanning the
    // section element across all max_columns grid tracks (including the 0-width
    // placeholder tracks for unused columns), so the measured section width equals
    // the wrapper content width — NOT column_span/max_columns × content_width.
    const sectionNaturalWidth = naturalWidth > 0 ? naturalWidth : 0;

    // sectionHost: where hui-section / card elements are appended.
    //
    // Desktop (viewport ≥ 768 px): pin the section to its exact natural pixel
    // width so cards are always the same size as on the source dashboard,
    // regardless of how wide or narrow the global-cards element itself is.
    // overflow:hidden on the container clips any right-hand overhang; the
    // cards are never squished.
    //
    // Mobile (viewport < 768 px): let the section fill the available width
    // and set --column-span:1 so hui-grid-section collapses to a 12-column
    // single-section layout — the same responsive behaviour HA uses natively.
    const isMobile = window.innerWidth < 768;
    let sectionHost = container;
    let inner = null;
    if (!isMobile) {
      // Always create an inner wrapper on desktop.  We use max-width (not a fixed
      // width) so the section caps at the source-dashboard size when the container
      // is wide enough, but gracefully fills a narrower container instead of
      // overflowing and being clipped.  No overflow:hidden needed.
      container.style.cssText = 'display: block; width: 100%; min-width: 0;';
      inner = document.createElement('div');
      // max-width caps the section at the source size; width:100% fills narrower containers.
      inner.style.cssText = sectionNaturalWidth > 0
        ? `max-width: ${sectionNaturalWidth}px; width: 100%; box-sizing: border-box;`
        : 'width: 100%;';
      container.appendChild(inner);
      sectionHost = inner;

      // Watch hui-root for resize events and snap the inner div to the
      // settled width once the DOM is stable.  Handles two failure modes:
      //  (a) naturalWidth was 0 because hui-root wasn't in the DOM yet
      //  (b) sidebar was still animating so the initial reading was too small
      if (!config?.section_width) {
        // Pass span=1, count=1 so _updateWidthOnSettle sets width = naturalWidth
        // directly (single section always fills the full wrapper content area).
        _updateWidthOnSettle([inner], config, [1], 1);
      }
    }

    if (useHuiSection) {
      // --column-count / --content-column-count / --column-span must all be set
      // to the section's column_span (NOT max_columns).  HA sets --column-count
      // equal to column_span so hui-grid-section builds the correct number of
      // card columns (e.g. 3 columns of 500 px each for column_span:3).
      const effectiveColSpan = isMobile ? 1 : sectionColumnSpan;
      const effectiveColCount = isMobile ? 1 : sectionColumnSpan;
      sectionHost.style.cssText = [
        isMobile
          ? 'display: contents'
          : sectionNaturalWidth > 0
            ? `max-width: ${sectionNaturalWidth}px; width: 100%; box-sizing: border-box;`
            : 'width: 100%;',
        `--column-count: ${effectiveColCount}`,
        `--content-column-count: ${effectiveColCount}`,
        `--column-span: ${effectiveColSpan}`,
      ].join('; ');

      const sectionEl = document.createElement('hui-section');
      sectionEl.hass = hass;
      sectionEl.config = section;
      sectionEl.lovelace = lovelace;
      sectionEl.index = 0;
      sectionEl.viewIndex = 0;
      cards.push(sectionEl);
      cardCount = section.cards?.length ?? 0;
      sectionHost.appendChild(sectionEl);
    } else {
      sectionHost.style.cssText = SECTION_GRID_STYLE;
      for (const cardConfig of section.cards || []) {
        try {
          const card = await helpers.createCardElement(cardConfig);
          card.hass = hass;
          const cols = cardConfig.grid_options?.columns;
          card.style.gridColumn = (!cols || cols === 'full') ? 'span 12' : `span ${cols}`;
          if (cardConfig.grid_options?.rows) card.style.gridRow = `span ${cardConfig.grid_options.rows}`;
          cards.push(card);
          cardCount++;
          sectionHost.appendChild(card);
        } catch (err) {
          console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
        }
      }
    }
  } else {
    // Multiple sections: flex-wrap row — sections sit side-by-side on desktop
    // and stack vertically on mobile (flex-wrap takes care of that).
    // Desktop: each section gets its exact natural pixel width; the outer
    // container clips overflow with overflow:hidden so the grid track doesn't
    // expand.  Mobile: each section is full-width with --column-span:1.
    const isMobile = window.innerWidth < 768;
    let sectionHost = container;
    if (!isMobile) {
      // Always create the flex wrapper on desktop — even if naturalWidth is 0
      // at init time the _updateWidthOnSettle call below will fix section widths.
      container.style.cssText = 'display: block; width: 100%; min-width: 0; overflow: hidden';
      const inner = document.createElement('div');
      inner.style.cssText = `display: flex; flex-wrap: wrap; box-sizing: border-box; gap: var(--masonry-view-card-margin, 8px); width: fit-content`;
      container.appendChild(inner);
      sectionHost = inner;
    } else {
      sectionHost.style.cssText = SECTION_FLEX_STYLE;
    }

    // Collect pinned-width section elements so we can update them on settle.
    const _pinnedSectionEls = [];
    const _pinnedColSpans = [];

    for (const [i, section] of structure.sections.entries()) {
      const colSpan = section.column_span || 1;
      const sectionNaturalWidth = (!isMobile && naturalWidth > 0)
        ? Math.round(naturalWidth * colSpan / columnCount)
        : 0;

      if (useHuiSection) {
        // --column-count must equal column_span (not max_columns) so the card
        // grid inside hui-grid-section has the same proportions as the source.
        const effectiveColCount = isMobile ? 1 : colSpan;
        const effectiveColSpan  = isMobile ? 1 : colSpan;
        const sectionEl = document.createElement('hui-section');
        sectionEl.style.cssText = sectionNaturalWidth > 0
          ? [
              `flex: 0 0 ${sectionNaturalWidth}px`,
              'min-width: 0',
              `--column-count: ${effectiveColCount}`,
              `--content-column-count: ${effectiveColCount}`,
              `--column-span: ${effectiveColSpan}`,
            ].join('; ')
          : [
              `flex: ${isMobile ? '1 1 100%' : colSpan}`,
              'min-width: 0',
              `--column-count: ${effectiveColCount}`,
              `--content-column-count: ${effectiveColCount}`,
              `--column-span: ${effectiveColSpan}`,
            ].join('; ');
        sectionEl.hass = hass;
        sectionEl.config = section;
        sectionEl.lovelace = lovelace;
        sectionEl.index = i;
        sectionEl.viewIndex = 0;
        cards.push(sectionEl);
        cardCount += section.cards?.length ?? 0;
        sectionHost.appendChild(sectionEl);
        if (sectionNaturalWidth > 0) {
          _pinnedSectionEls.push(sectionEl);
          _pinnedColSpans.push(colSpan);
        }
      } else {
        const sectionEl = document.createElement('div');
        sectionEl.style.cssText = sectionNaturalWidth > 0
          ? `flex: 0 0 ${sectionNaturalWidth}px; min-width: 0; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--masonry-view-card-margin, 8px); align-content: start;`
          : `flex: ${isMobile ? '1 1 100%' : colSpan}; min-width: 0; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--masonry-view-card-margin, 8px); align-content: start;`;
        for (const cardConfig of section.cards || []) {
          try {
            const card = await helpers.createCardElement(cardConfig);
            card.hass = hass;
            const cols = cardConfig.grid_options?.columns;
            card.style.gridColumn = (!cols || cols === 'full') ? 'span 12' : `span ${cols}`;
            if (cardConfig.grid_options?.rows) card.style.gridRow = `span ${cardConfig.grid_options.rows}`;
            cards.push(card);
            cardCount++;
            sectionEl.appendChild(card);
          } catch (err) {
            console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
          }
        }
        sectionHost.appendChild(sectionEl);
      }
    }

    // Schedule deferred width correction for multi-section pinned elements.
    if (!isMobile && !config?.section_width && _pinnedSectionEls.length) {
      _updateWidthOnSettle(_pinnedSectionEls, config, _pinnedColSpans, columnCount);
    }
  }

  return { cards, cardCount };
}

// ── Inline flat ───────────────────────────────────────────────────────────────

async function buildInlineFlat(structure, hass, helpers, container) {
  const cards = [];
  let cardCount = 0;

  container.style.cssText = FLAT_CONTAINER_STYLE;

  for (const cardConfig of structure.cards) {
    try {
      const card = await helpers.createCardElement(cardConfig);
      card.hass = hass;
      cards.push(card);
      cardCount++;
      container.appendChild(card);
    } catch (err) {
      console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
    }
  }

  return { cards, cardCount };
}

// ── Popup ─────────────────────────────────────────────────────────────────────

async function buildPopup(structure, hass, helpers, container) {
  const cards = [];
  let cardCount = 0;

  const cardConfigs = structure.type === 'sections'
    ? structure.sections.flatMap(s => s.cards || [])
    : structure.cards;

  for (const cardConfig of cardConfigs) {
    try {
      const card = await helpers.createCardElement(cardConfig);
      card.hass = hass;
      card.style.pointerEvents = 'auto';
      cards.push(card);
      cardCount++;
      container.appendChild(card);
    } catch (err) {
      console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
    }
  }

  return { cards, cardCount };
}

// ── Public entry point ────────────────────────────────────────────────────────

async function loadCards(instance) {
  const myLoadId = ++instance._loadId;
  const { _config: config, _hass: hass } = instance;

  if (!config.source_dashboard?.trim()) return;

  const isInline = config.mode === 'inline';
  const key = cacheKey(config);

  if (!isInline) {
    const appendTarget = findAppendTarget();

    // Reuse existing container if already injected
    const existing = findExistingContainer(appendTarget, key);
    if (existing) {
      instance._container = existing;
      instance._cards = Array.from(existing.querySelectorAll(':scope > *'));
      instance._cardCount = instance._cards.length;
      for (const card of instance._cards) card.hass = hass;
      registerPopupContainer(key, existing, config.source_dashboard, config.source_view);
      instance._updateVisibility();
      return;
    }

    let lovelaceConfig;
    try {
      lovelaceConfig = await fetchLovelaceConfig(hass, config);
    } catch (err) {
      console.error('[global-cards]', err);
      return;
    }

    if (myLoadId !== instance._loadId) return;

    const structure = extractStructure(lovelaceConfig, config);
    const helpers = await window.loadCardHelpers();

    if (myLoadId !== instance._loadId) return;

    const container = document.createElement('div');
    container.setAttribute('data-global-cards-key', key);
    Object.assign(container.style, {
      position: 'fixed', top: '0', left: '0',
      width: '0', height: '0',
      overflow: 'visible', pointerEvents: 'none', zIndex: '9999',
    });
    appendTarget.appendChild(container);
    instance._container = container;

    const result = await buildPopup(structure, hass, helpers, container);
    instance._cards = result.cards;
    instance._cardCount = result.cardCount;

    registerPopupContainer(key, container, config.source_dashboard, config.source_view);
    instance._updateVisibility();
    return;
  }

  // Inline mode
  let lovelaceConfig;
  try {
    lovelaceConfig = await fetchLovelaceConfig(hass, config);
  } catch (err) {
    console.error('[global-cards]', err);
    return;
  }

  if (myLoadId !== instance._loadId) return;

  const structure = extractStructure(lovelaceConfig, config);
  const helpers = await window.loadCardHelpers();

  if (myLoadId !== instance._loadId) return;

  const container = document.createElement('div');
  instance._contentEl.appendChild(container);
  instance._container = container;

  const result = structure.type === 'sections'
    ? await buildInlineSections(structure, hass, helpers, container, lovelaceConfig, config.source_dashboard, config)
    : await buildInlineFlat(structure, hass, helpers, container);

  instance._cards = result.cards;
  instance._cardCount = result.cardCount;

  instance._updateVisibility();
}

function cleanupPopupContainer(key) {
  unregisterPopupContainer(key);
}

function getHuiRoot(cache) {
  if (cache.huiRoot) return cache.huiRoot;
  try {
    const root = document.querySelector('home-assistant')
      ?.shadowRoot?.querySelector('home-assistant-main')
      ?.shadowRoot?.querySelector('ha-drawer')
      ?.querySelector('partial-panel-resolver ha-panel-lovelace')
      ?.shadowRoot?.querySelector('hui-root');
    cache.huiRoot = root ?? null;
    return cache.huiRoot;
  } catch {
    return null;
  }
}

function isEditMode(cache) {
  try {
    return getHuiRoot(cache)?.lovelace?.editMode ?? false;
  } catch {
    return false;
  }
}

function setupEditModeWatcher(cache, updateVisibility) {
  const huiRoot = getHuiRoot(cache);
  if (huiRoot) {
    cache.editObserver = new MutationObserver(updateVisibility);
    cache.editObserver.observe(huiRoot, { attributes: true });
  }
  window.addEventListener('lovelace-edit-mode-changed', updateVisibility);
}

function teardownEditModeWatcher(cache, updateVisibility) {
  window.removeEventListener('lovelace-edit-mode-changed', updateVisibility);
}

function showEditCard(contentEl, config, cardCount) {
  const source = config.source_dashboard;
  const view = config.source_view ?? 'all views';

  let status, color;
  if (!source) {
    status = '⚠️ No source view selected';
    color = '#ef5350';
  } else if (cardCount > 0) {
    status = `✓ ${cardCount} card(s) loaded`;
    color = '#4caf50';
  } else {
    status = '⏳ Waiting for load...';
    color = '#f59e0b';
  }

  contentEl.innerHTML = `
    <div class="gcc-status" style="
      padding: 12px 16px; border-radius: 12px;
      background: #1a1a2e; border: 1px solid ${color};
      color: ${color}; font-size: 13px; font-family: monospace;
      display: flex; align-items: center; gap: 10px;
    ">
      <span style="font-size:18px">🌐</span>
      <span>
        <b>global-cards</b><br/>
        <span style="color:#aaa">${source ?? '–'} / ${view}<br/>${status}</span>
      </span>
    </div>`;
}

function showEditBadge(contentEl, config, cardCount) {
  let badge = contentEl.querySelector('#gcc-edit-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'gcc-edit-badge';
    badge.style.cssText = BADGE_STYLE;
    contentEl.appendChild(badge);
  }
  badge.textContent = `🌐 ${config.source_dashboard} / ${config.source_view ?? 'all views'} · ${cardCount} card(s)`;
}

function hideEditBadge(contentEl) {
  contentEl.querySelector('#gcc-edit-badge')?.remove();
}

class GlobalCards extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = HOST_STYLE;
    this.shadowRoot.appendChild(style);

    this._contentEl = document.createElement('div');
    this.shadowRoot.appendChild(this._contentEl);

    this._cards = [];
    this._cardCount = 0;
    this._container = null;
    this._loaded = false;
    this._loadId = 0;
    this._hass = null;
    this._config = {};

    this._updateVisibility = this._updateVisibility.bind(this);
  }

  setConfig(config) {
    const prevSource = this._config.source_dashboard;
    const prevView = this._config.source_view;
    const prevMode = this._config.mode;

    this._config = config;

    const sourceChanged = config.source_dashboard !== prevSource
      || config.source_view !== prevView;
    const modeChanged = config.mode !== prevMode;

    if ((sourceChanged || modeChanged) && this._loaded) {
      this._cleanup();
      if (config.source_dashboard?.trim() && this._hass) {
        this._loaded = true;
        loadCards(this);
        return;
      }
    }

    this._updateVisibility();
  }

  set hass(hass) {
    this._hass = hass;
    for (const card of this._cards) card.hass = hass;
    if (!this._loaded && this.isConnected) {
      this._loaded = true;
      loadCards(this);
    }
  }

  connectedCallback() {
    setupEditModeWatcher({ huiRoot: getHuiRoot(this) }, this._updateVisibility);
    this._updateVisibility();
    if (this._hass && !this._loaded) {
      this._loaded = true;
      loadCards(this);
    }
  }

  disconnectedCallback() {
    this._loadId++;
    this._loaded = false;
    this._cards = [];
    this._cardCount = 0;

    if (this._container) {
      if (this._isInline()) {
        this._container.remove();
      }
      // Popup containers stay in the DOM so Bubble Card remains registered.
      // navigation.js removes them only when navigating to the source dashboard.
      this._container = null;
    }

    teardownEditModeWatcher({ }, this._updateVisibility);
  }

  _isInline() {
    return this._config.mode === 'inline';
  }

  _updateVisibility() {
    const host = this.getRootNode()?.host;
    const huiCard = host?.tagName?.toLowerCase() === 'hui-card' ? host : null;
    const editMode = isEditMode(this);
    const hasSource = !!this._config.source_dashboard?.trim();

    if (this._isInline()) {
      this.style.cssText = '';
      if (huiCard) huiCard.style.cssText = '';

      if (editMode) {
        const hasCards = this._cardCount > 0 && !!this._container;
        if (!hasSource || !hasCards) {
          hideEditBadge(this._contentEl);
          this._contentEl.querySelector('.gcc-status')?.remove();
          showEditCard(this._contentEl, this._config, this._cardCount);
        } else {
          this._contentEl.querySelector('.gcc-status')?.remove();
          showEditBadge(this._contentEl, this._config, this._cardCount);
        }
      } else {
        hideEditBadge(this._contentEl);
        this._contentEl.querySelector('.gcc-status')?.remove();
      }
      return;
    }

    // Popup mode
    if (editMode) {
      this.style.cssText = '';
      if (huiCard) huiCard.style.cssText = '';
      showEditCard(this._contentEl, this._config, this._cardCount);
    } else {
      this.style.cssText = POPUP_HIDDEN_STYLE;
      if (huiCard) huiCard.style.cssText = 'display:none!important;';
      this._contentEl.innerHTML = '';
    }
  }

  _cleanup() {
    this._loadId++;
    if (this._container) {
      if (!this._isInline()) {
        cleanupPopupContainer(cacheKey(this._config));
      } else {
        this._container.remove();
      }
      this._container = null;
    }
    this._contentEl.innerHTML = '';
    this._cards = [];
    this._cardCount = 0;
    this._loaded = false;
  }

  getCardSize() {
    if (this._isInline()) return 3;
    return isEditMode(this) ? 1 : 0;
  }

  static getConfigElement() {
    return document.createElement('global-cards-editor');
  }

  static getStubConfig() {
    return {
      source_dashboard: '',
      source_view: '',
      mode: 'popup',
    };
  }
}

class GlobalCardsEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._hass = null;
    this._rendered = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) {
      this._render();
    } else {
      const picker = this.shadowRoot.getElementById('nav-picker');
      if (picker) picker.hass = hass;
      const form = this.shadowRoot.getElementById('ha-form');
      if (form) form.hass = hass;
    }
  }

  setConfig(config) {
    this._config = { ...config };
    if (this._rendered) this._updateValues();
  }

  _currentPath() {
    const { source_dashboard, source_view } = this._config;
    if (!source_dashboard) return '';
    return source_view
      ? `/${source_dashboard}/${source_view}`
      : `/${source_dashboard}`;
  }

  _render() {
    if (!this._hass) return;
    this._rendered = true;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: flex;
          flex-direction: column;
          gap: 16px;
          padding: 16px 0;
        }
        label {
          font-size: 12px;
          font-weight: 500;
          color: var(--secondary-text-color);
          text-transform: uppercase;
          letter-spacing: 0.4px;
        }
        .row {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
      </style>
      <div class="row">
        <label>Source view</label>
        <ha-navigation-picker id="nav-picker"></ha-navigation-picker>
      </div>
      <ha-form id="ha-form"></ha-form>
    `;

    const picker = this.shadowRoot.getElementById('nav-picker');
    picker.hass = this._hass;
    picker.label = 'Dashboard / View';
    picker.addEventListener('value-changed', (e) => {
      const path = (e.detail.value || '').replace(/^\//, '');
      const parts = path.split('/');
      this._config = {
        ...this._config,
        source_dashboard: parts[0] ?? '',
        source_view: parts[1] ?? '',
      };
      this._fireConfigChanged();
    });

    const form = this.shadowRoot.getElementById('ha-form');
    form.hass = this._hass;
    form.schema = [
      {
        name: 'mode',
        label: 'Mode',
        selector: {
          select: {
            mode: 'dropdown',
            options: [
              { value: 'popup', label: 'Popup (invisible)' },
              { value: 'inline', label: 'Inline (visible)' },
            ],
          },
        },
      },
    ];
    form.computeLabel = (s) => s.label;
    form.addEventListener('value-changed', (e) => {
      const { mode } = e.detail.value;
      if (mode !== undefined && mode !== this._config.mode) {
        this._config = { ...this._config, mode };
        this._fireConfigChanged();
      }
    });

    this._updateValues();
  }

  _updateValues() {
    const picker = this.shadowRoot.getElementById('nav-picker');
    if (picker) {
      picker.hass = this._hass;
      picker.value = this._currentPath();
    }
    const form = this.shadowRoot.getElementById('ha-form');
    if (form) {
      form.data = { mode: this._config.mode || 'popup' };
    }
  }

  _fireConfigChanged() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    }));
  }
}

// Guard prevents "already defined" errors when HA hot-loads a new resource URL
// while the old module is still registered.  A hard reload is still required to
// activate new code; this just avoids a noisy console exception.
if (!customElements.get('global-cards')) {
  customElements.define('global-cards', GlobalCards);
}
if (!customElements.get('global-cards-editor')) {
  customElements.define('global-cards-editor', GlobalCardsEditor);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'global-cards',
  name: 'Global Cards',
  description: 'Define cards once, reuse them across multiple dashboards.',
  preview: false,
});
