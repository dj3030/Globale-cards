import { GlobalCards } from './GlobalCards.js';
import { GlobalCardsEditor } from './editor.js';

customElements.define('global-cards', GlobalCards);
customElements.define('global-cards-editor', GlobalCardsEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'global-cards',
  name: 'Global Cards',
  description: 'Define cards once, reuse them across multiple dashboards.',
  preview: false,
});
