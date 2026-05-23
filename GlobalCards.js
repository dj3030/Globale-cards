import { HOST_STYLE, POPUP_HIDDEN_STYLE } from './styles.js';
import { loadCards, cacheKey } from './loader.js';
import {
  getHuiRoot,
  isEditMode,
  setupEditModeWatcher,
  teardownEditModeWatcher,
  showEditCard,
  showEditBadge,
  hideEditBadge,
} from './edit-mode.js';

export class GlobalCards extends HTMLElement {
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
    this._huiRootCache = null;
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

    if (this._isInline() && this._container) {
      this._container.remove();
    }
    this._container = null;

    teardownEditModeWatcher({ editObserver: null }, this._updateVisibility);
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
      this._container.remove();
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
