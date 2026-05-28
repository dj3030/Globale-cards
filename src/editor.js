export class GlobalCardsEditor extends HTMLElement {
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
