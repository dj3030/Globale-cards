import { registerPopupContainer, unregisterPopupContainer } from './navigation.js';
import {
  SECTION_GRID_STYLE,
  SECTION_FLEX_STYLE,
  FLAT_CONTAINER_STYLE,
} from './styles.js';

// ── Config cache ─────────────────────────────────────────────────────────────
const _configCache = new Map();
const CONFIG_CACHE_TTL = 60_000;

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

// ── Inline sections ───────────────────────────────────────────────────────────

async function buildInlineSections(structure, hass, helpers, container, lovelaceConfig, urlPath) {
  const useHuiSection = !!customElements.get('hui-section');
  const lovelace = buildLovelace(hass, lovelaceConfig, urlPath);
  const cards = [];
  let cardCount = 0;

  // Resolve column count: inherit from ancestor sections-view if available,
  // otherwise fall back to the section's column_span or view max_columns.
  // This value drives --column-span on hui-section which controls the number
  // of CSS grid columns inside hui-grid-section:
  //   grid-template-columns: repeat(calc(12 * var(--column-span, 1)), 1fr)
  const inheritedCC = parseInt(
    getComputedStyle(container).getPropertyValue('--column-count').trim()
  ) || 0;
  const columnCount = inheritedCC
    || structure.sections[0]?.column_span
    || structure.maxColumns;

  if (structure.sections.length === 1) {
    const section = structure.sections[0];
    const sectionColumnSpan = section.column_span || 1;

    if (useHuiSection) {
      // display: contents makes the container transparent so hui-section
      // participates directly in the parent layout.
      // --column-count / --content-column-count / --column-span must all be
      // set so that hui-grid-section inside hui-section computes the right
      // number of CSS grid columns.
      container.style.cssText = [
        'display: contents',
        `--column-count: ${columnCount}`,
        `--content-column-count: ${columnCount}`,
        `--column-span: ${sectionColumnSpan}`,
      ].join('; ');

      const sectionEl = document.createElement('hui-section');
      sectionEl.hass = hass;
      sectionEl.config = section;
      sectionEl.lovelace = lovelace;
      sectionEl.index = 0;
      sectionEl.viewIndex = 0;
      cards.push(sectionEl);
      cardCount = section.cards?.length ?? 0;
      container.appendChild(sectionEl);
    } else {
      container.style.cssText = SECTION_GRID_STYLE;
      for (const cardConfig of section.cards || []) {
        try {
          const card = await helpers.createCardElement(cardConfig);
          card.hass = hass;
          const cols = cardConfig.grid_options?.columns;
          card.style.gridColumn = (!cols || cols === 'full') ? 'span 12' : `span ${cols}`;
          if (cardConfig.grid_options?.rows) card.style.gridRow = `span ${cardConfig.grid_options.rows}`;
          cards.push(card);
          cardCount++;
          container.appendChild(card);
        } catch (err) {
          console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
        }
      }
    }
  } else {
    container.style.cssText = SECTION_FLEX_STYLE;

    for (const [i, section] of structure.sections.entries()) {
      const colSpan = section.column_span || 1;

      if (useHuiSection) {
        const sectionEl = document.createElement('hui-section');
        sectionEl.style.cssText = [
          `flex: ${colSpan}`,
          'min-width: 0',
          `--column-count: ${columnCount}`,
          `--content-column-count: ${columnCount}`,
          `--column-span: ${colSpan}`,
        ].join('; ');
        sectionEl.hass = hass;
        sectionEl.config = section;
        sectionEl.lovelace = lovelace;
        sectionEl.index = i;
        sectionEl.viewIndex = 0;
        cards.push(sectionEl);
        cardCount += section.cards?.length ?? 0;
        container.appendChild(sectionEl);
      } else {
        const sectionEl = document.createElement('div');
        sectionEl.style.cssText = `flex: ${colSpan}; min-width: 0; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--masonry-view-card-margin, 8px); align-content: start;`;
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
        container.appendChild(sectionEl);
      }
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

    registerPopupContainer(key, container, config.source_dashboard);
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
    ? await buildInlineSections(structure, hass, helpers, container, lovelaceConfig, config.source_dashboard)
    : await buildInlineFlat(structure, hass, helpers, container);

  instance._cards = result.cards;
  instance._cardCount = result.cardCount;

  instance._updateVisibility();
}

export function cleanupPopupContainer(key) {
  unregisterPopupContainer(key);
}
