// Håndterer fjernelse af popup-containere når brugeren
// navigerer til source dashboard for at undgå hash-konflikter.

const _registry = new Map(); // cacheKey → { container, sourceDashboard }

function _handleNavigation() {
  for (const entry of _registry.values()) {
    const onSource = window.location.pathname.includes(`/${entry.sourceDashboard}`);

    if (onSource && entry.container.isConnected) {
      // Fjern container så Bubble Card ikke registrerer samme hashes to gange
      entry.container.remove();
    }
    // Vi genindsætter IKKE her — det sker via connectedCallback
    // når global-cards elementet loades på den rigtige side igen
  }
}

window.addEventListener('location-changed', _handleNavigation);
window.addEventListener('popstate', _handleNavigation);

export function registerPopupContainer(key, container, sourceDashboard) {
  _registry.set(key, { container, sourceDashboard });
}

export function unregisterPopupContainer(key) {
  const entry = _registry.get(key);
  if (entry) {
    entry.container.remove();
    _registry.delete(key);
  }
}
