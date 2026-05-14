const _lovelaceConfigCache = new Map();
const _CONFIG_CACHE_TTL = 60_000;

class GlobalCards extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    // Persistent style – never removed
    const style = document.createElement('style');
    style.textContent = ':host { display: block; width: 100%; box-sizing: border-box; }';
    this.shadowRoot.appendChild(style);

    // Persistent content slot – all dynamic content goes here
    this._contentEl = document.createElement('div');
    this.shadowRoot.appendChild(this._contentEl);

    this._cards = [];
    this._container = null;
    this._loaded = false;
    this._loadId = 0;
    this._hass = null;
    this._config = {};
    this._editObserver = null;
    this._huiRootCache = null;
    this._updateVisibility = this._updateVisibility.bind(this);
  }

  setConfig(config) {
    if (!config.source_dashboard) {
      throw new Error('[global-cards] source_dashboard is required');
    }
    this._config = config;
    this._updateVisibility();
  }

  set hass(hass) {
    this._hass = hass;
    for (const card of this._cards) {
      card.hass = hass;
    }
    if (!this._loaded && this.isConnected) {
      this._loaded = true;
      this._loadCards();
    }
  }

  connectedCallback() {
    this._setupEditModeWatcher();
    this._updateVisibility();
    if (this._hass && !this._loaded) {
      this._loaded = true;
      this._loadCards();
    }
  }

  disconnectedCallback() {
    this._loadId++;
    this._loaded = false;
    this._cards = [];

    if (this._isInline() && this._container) {
      this._container.remove();
    }
    this._container = null;

    if (this._editObserver) {
      this._editObserver.disconnect();
      this._editObserver = null;
    }
    window.removeEventListener('lovelace-edit-mode-changed', this._updateVisibility);
  }

  _isInline() {
    return this._config.mode === 'inline';
  }

  _cacheKey() {
    return `${this._config.source_dashboard}::${this._config.source_view || ''}`;
  }

  // ─── Edit mode ────────────────────────────────────────────────────────────

  _getHuiRoot() {
    if (this._huiRootCache) return this._huiRootCache;
    try {
      const root = document.querySelector('home-assistant')
        ?.shadowRoot?.querySelector('home-assistant-main')
        ?.shadowRoot?.querySelector('ha-drawer')
        ?.querySelector('partial-panel-resolver ha-panel-lovelace')
        ?.shadowRoot?.querySelector('hui-root');
      this._huiRootCache = root ?? null;
      return this._huiRootCache;
    } catch (e) {
      return null;
    }
  }

  _isEditMode() {
    try {
      return this._getHuiRoot()?.lovelace?.editMode ?? false;
    } catch (e) {
      return false;
    }
  }

  _setupEditModeWatcher() {
    const huiRoot = this._getHuiRoot();
    if (huiRoot) {
      this._editObserver = new MutationObserver(this._updateVisibility);
      this._editObserver.observe(huiRoot, { attributes: true });
    }
    window.addEventListener('lovelace-edit-mode-changed', this._updateVisibility);
  }

  _updateVisibility() {
    const host = this.getRootNode()?.host;
    const huiCard = host?.tagName?.toLowerCase() === 'hui-card' ? host : null;

    if (this._isInline()) {
      this.style.cssText = '';
      if (huiCard) huiCard.style.cssText = '';
      if (this._isEditMode()) {
        this._showEditBadge();
      } else {
        this._hideEditBadge();
      }
      return;
    }

    if (this._isEditMode()) {
      this.style.cssText = '';
      if (huiCard) huiCard.style.cssText = '';
      this._showEditCard();
    } else {
      this.style.cssText = `
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 0 !important; height: 0 !important;
        overflow: hidden !important;
        pointer-events: none !important;
      `;
      if (huiCard) huiCard.style.cssText = 'display:none!important;';
      this._contentEl.innerHTML = '';
    }
  }

  _showEditCard() {
    const count = this._cards.length;
    const source = this._config.source_dashboard ?? '–';
    const view = this._config.source_view ?? 'all views';
    const status = count > 0 ? `✓ ${count} card(s) loaded` : `⏳ Waiting for load...`;
    const color = count > 0 ? '#4caf50' : '#f59e0b';
    this._contentEl.innerHTML = `
      <div style="
        padding: 12px 16px; border-radius: 12px;
        background: #1a1a2e; border: 1px solid ${color};
        color: ${color}; font-size: 13px; font-family: monospace;
        display: flex; align-items: center; gap: 10px;
      ">
        <span style="font-size:18px">🌐</span>
        <span>
          <b>global-cards</b><br/>
          <span style="color:#aaa">${source} / ${view}<br/>${status}</span>
        </span>
      </div>`;
  }

  _showEditBadge() {
    let badge = this._contentEl.querySelector('#gcc-edit-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'gcc-edit-badge';
      badge.style.cssText = `
        position: absolute; top: 4px; right: 4px;
        padding: 2px 8px; border-radius: 8px;
        background: #1a1a2e; border: 1px solid #4caf50;
        color: #4caf50; font-size: 11px; font-family: monospace;
        z-index: 1; pointer-events: none;
      `;
      this._contentEl.appendChild(badge);
    }
    badge.textContent = `🌐 ${this._config.source_dashboard} / ${this._config.source_view ?? 'all views'} · ${this._cards.length} card(s)`;
  }

  _hideEditBadge() {
    this._contentEl.querySelector('#gcc-edit-badge')?.remove();
  }

  // ─── Loader ───────────────────────────────────────────────────────────────

  _findAppendTarget() {
    try {
      const huiRoot = this._getHuiRoot();
      return huiRoot?.shadowRoot ?? document.body;
    } catch (e) {
      return document.body;
    }
  }

  _findExistingContainer() {
    try {
      return this._findAppendTarget()
        ?.querySelector(`[data-global-cards-key="${this._cacheKey()}"]`) ?? null;
    } catch (e) {
      return null;
    }
  }

  _buildLovelace(lovelaceConfig) {
    return {
      config: lovelaceConfig,
      editMode: false,
      mode: 'storage',
      locale: this._hass.locale,
      enableFullEditMode: () => {},
      saveConfig: async () => {},
      deleteConfig: async () => {},
      showToast: () => {},
    };
  }

  async _loadCards() {
    const myLoadId = ++this._loadId;

    // Popup: reuse existing container in hui-root
    if (!this._isInline()) {
      const existing = this._findExistingContainer();
      if (existing) {
        this._container = existing;
        this._cards = Array.from(existing.children);
        for (const card of this._cards) card.hass = this._hass;
        this._updateVisibility();
        return;
      }
    }

    // Fetch config with cache
    let lovelaceConfig;
    const cacheKey = this._cacheKey();
    const cached = _lovelaceConfigCache.get(cacheKey);

    if (cached && Date.now() - cached.ts < _CONFIG_CACHE_TTL) {
      lovelaceConfig = cached.config;
    } else {
      try {
        lovelaceConfig = await this._hass.callWS({
          type: 'lovelace/config',
          url_path: this._config.source_dashboard,
        });
        _lovelaceConfigCache.set(cacheKey, { config: lovelaceConfig, ts: Date.now() });
      } catch (err) {
        console.error('[global-cards]', err);
        return;
      }
    }

    if (myLoadId !== this._loadId) return;

    const structure = this._extractStructure(lovelaceConfig);
    const helpers = await window.loadCardHelpers();

    if (myLoadId !== this._loadId) return;

    // ── Inline ──────────────────────────────────────────────────────────────
    if (this._isInline()) {
      this._container = document.createElement('div');
      this._contentEl.appendChild(this._container);

      if (structure.type === 'sections') {
        const useHuiSection = !!customElements.get('hui-section');
        const lovelace = this._buildLovelace(lovelaceConfig);

        if (structure.sections.length === 1) {
          // Single section: container IS the 12-col grid directly
          if (useHuiSection) {
            this._container.style.cssText = 'display: contents;';
            const sectionEl = document.createElement('hui-section');
            sectionEl.hass = this._hass;
            sectionEl.config = structure.sections[0];
            sectionEl.lovelace = lovelace;
            sectionEl.index = 0;
            sectionEl.viewIndex = 0;
            this._cards.push(sectionEl);
            this._container.appendChild(sectionEl);
          } else {
            this._container.style.cssText = `
              width: 100%;
              box-sizing: border-box;
              display: grid;
              grid-template-columns: repeat(12, minmax(0, 1fr));
              gap: var(--masonry-view-card-margin, 8px);
              align-content: start;
            `;
            for (const cardConfig of structure.sections[0].cards || []) {
              try {
                const card = await helpers.createCardElement(cardConfig);
                card.hass = this._hass;
                const cols = cardConfig.grid_options?.columns;
                card.style.gridColumn = (!cols || cols === 'full') ? 'span 12' : `span ${cols}`;
                if (cardConfig.grid_options?.rows) card.style.gridRow = `span ${cardConfig.grid_options.rows}`;
                this._cards.push(card);
                this._container.appendChild(card);
              } catch (err) {
                console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
              }
            }
          }
        } else {
          // Multiple sections: flex row, each proportional to column_span
          this._container.style.cssText = `
            width: 100%;
            box-sizing: border-box;
            display: flex;
            flex-direction: row;
            gap: var(--masonry-view-card-margin, 8px);
          `;
          for (const [i, section] of structure.sections.entries()) {
            const colSpan = section.column_span || 1;

            if (useHuiSection) {
              const sectionEl = document.createElement('hui-section');
              sectionEl.style.cssText = `flex: ${colSpan}; min-width: 0;`;
              sectionEl.hass = this._hass;
              sectionEl.config = section;
              sectionEl.lovelace = lovelace;
              sectionEl.index = i;
              sectionEl.viewIndex = 0;
              this._cards.push(sectionEl);
              this._container.appendChild(sectionEl);
            } else {
              const sectionEl = document.createElement('div');
              sectionEl.style.cssText = `
                flex: ${colSpan};
                min-width: 0;
                display: grid;
                grid-template-columns: repeat(12, minmax(0, 1fr));
                gap: var(--masonry-view-card-margin, 8px);
                align-content: start;
              `;
              for (const cardConfig of section.cards || []) {
                try {
                  const card = await helpers.createCardElement(cardConfig);
                  card.hass = this._hass;
                  const cols = cardConfig.grid_options?.columns;
                  card.style.gridColumn = (!cols || cols === 'full') ? 'span 12' : `span ${cols}`;
                  if (cardConfig.grid_options?.rows) card.style.gridRow = `span ${cardConfig.grid_options.rows}`;
                  this._cards.push(card);
                  sectionEl.appendChild(card);
                } catch (err) {
                  console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
                }
              }
              this._container.appendChild(sectionEl);
            }
          }
        }
      } else {
        // Flat / masonry
        this._container.style.cssText = `
          width: 100%;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: var(--masonry-view-card-margin, 8px);
        `;
        for (const cardConfig of structure.cards) {
          try {
            const card = await helpers.createCardElement(cardConfig);
            card.hass = this._hass;
            this._cards.push(card);
            this._container.appendChild(card);
          } catch (err) {
            console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
          }
        }
      }

    // ── Popup ───────────────────────────────────────────────────────────────
    } else {
      const appendTarget = this._findAppendTarget();
      this._container = document.createElement('div');
      this._container.setAttribute('data-global-cards-key', cacheKey);
      Object.assign(this._container.style, {
        position: 'fixed', top: '0', left: '0',
        width: '0', height: '0',
        overflow: 'visible', pointerEvents: 'none', zIndex: '9999',
      });
      appendTarget.appendChild(this._container);

      const cardConfigs = structure.type === 'sections'
        ? structure.sections.flatMap(s => s.cards || [])
        : structure.cards;

      for (const cardConfig of cardConfigs) {
        try {
          const card = await helpers.createCardElement(cardConfig);
          card.hass = this._hass;
          card.style.pointerEvents = 'auto';
          this._cards.push(card);
          this._container.appendChild(card);
        } catch (err) {
          console.warn(`[global-cards] Could not create card "${cardConfig.type}":`, err);
        }
      }
    }

    this._updateVisibility();
  }

  _extractStructure(lovelaceConfig) {
    const views = lovelaceConfig.views || [];
    const { source_view } = this._config;

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

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  _cleanup() {
    this._loadId++;
    if (this._container) {
      this._container.remove();
      this._container = null;
    }
    this._contentEl.innerHTML = '';
    this._cards = [];
    this._loaded = false;
  }

  getCardSize() {
    if (this._isInline()) return 3;
    return this._isEditMode() ? 1 : 0;
  }
}

customElements.define('global-cards', GlobalCards);