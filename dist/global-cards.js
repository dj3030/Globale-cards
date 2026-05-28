const HOST_STYLE = ':host { display: block; width: 100%; box-sizing: border-box; }';

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
    ? await buildInlineSections(structure, hass, helpers, container, lovelaceConfig, config.source_dashboard)
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

customElements.define('global-cards', GlobalCards);
customElements.define('global-cards-editor', GlobalCardsEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'global-cards',
  name: 'Global Cards',
  description: 'Define cards once, reuse them across multiple dashboards.',
  preview: false,
});
