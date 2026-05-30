import { GlobalCards } from './GlobalCards.js';
import { GlobalCardsEditor } from './editor.js';

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
