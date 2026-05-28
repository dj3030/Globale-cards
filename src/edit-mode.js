import { BADGE_STYLE } from './styles.js';

export function getHuiRoot(cache) {
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

export function isEditMode(cache) {
  try {
    return getHuiRoot(cache)?.lovelace?.editMode ?? false;
  } catch {
    return false;
  }
}

export function setupEditModeWatcher(cache, updateVisibility) {
  const huiRoot = getHuiRoot(cache);
  if (huiRoot) {
    cache.editObserver = new MutationObserver(updateVisibility);
    cache.editObserver.observe(huiRoot, { attributes: true });
  }
  window.addEventListener('lovelace-edit-mode-changed', updateVisibility);
}

export function teardownEditModeWatcher(cache, updateVisibility) {
  if (cache.editObserver) {
    cache.editObserver.disconnect();
    cache.editObserver = null;
  }
  window.removeEventListener('lovelace-edit-mode-changed', updateVisibility);
}

export function showEditCard(contentEl, config, cardCount) {
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

export function showEditBadge(contentEl, config, cardCount) {
  let badge = contentEl.querySelector('#gcc-edit-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'gcc-edit-badge';
    badge.style.cssText = BADGE_STYLE;
    contentEl.appendChild(badge);
  }
  badge.textContent = `🌐 ${config.source_dashboard} / ${config.source_view ?? 'all views'} · ${cardCount} card(s)`;
}

export function hideEditBadge(contentEl) {
  contentEl.querySelector('#gcc-edit-badge')?.remove();
}
