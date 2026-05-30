import { registerPopupContainer, unregisterPopupContainer } from './navigation.js';
import {
  SECTION_GRID_STYLE,
  SECTION_FLEX_STYLE,
  FLAT_CONTAINER_STYLE,
} from './styles.js';

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

export function cacheKey(config) {
  return `${config.source_dashboard}::${config.source_view || ''}`;
}

export function findAppendTarget() {
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

export function findExistingContainer(appendTarget, key) {
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
export function buildLovelace(hass, lovelaceConfig, urlPath) {
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

export function extractStructure(lovelaceConfig, config) {
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

export async function loadCards(instance) {
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

export function cleanupPopupContainer(key) {
  unregisterPopupContainer(key);
}
