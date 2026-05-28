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

export function registerPopupContainer(key, container, sourceDashboard, sourceView) {
  _registry.set(key, { container, sourceDashboard, sourceView });
}

export function unregisterPopupContainer(key) {
  const entry = _registry.get(key);
  if (entry) {
    entry.container.remove();
    _registry.delete(key);
  }
}
