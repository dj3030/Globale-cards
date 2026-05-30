// min-width:0 is the canonical CSS Grid fix: without it the grid track expands
// to fit the shadow host's min-content width instead of its assigned track size.
// overflow:hidden ensures inner content wider than the track is clipped, not leaked.
export const HOST_STYLE = ':host { display: block; width: 100%; min-width: 0; overflow: hidden; box-sizing: border-box; }';

export const STATUS_CARD_STYLE = `
  padding: 12px 16px; border-radius: 12px;
  background: #1a1a2e; border: 1px solid {color};
  color: {color}; font-size: 13px; font-family: monospace;
  display: flex; align-items: center; gap: 10px;
`;

export const BADGE_STYLE = `
  position: absolute; top: 4px; right: 4px;
  padding: 2px 8px; border-radius: 8px;
  background: #1a1a2e; border: 1px solid #4caf50;
  color: #4caf50; font-size: 11px; font-family: monospace;
  z-index: 1; pointer-events: none;
`;

export const POPUP_HIDDEN_STYLE = `
  position: fixed !important;
  top: 0 !important; left: 0 !important;
  width: 0 !important; height: 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
`;

export const SECTION_GRID_STYLE = `
  width: 100%;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--masonry-view-card-margin, 8px);
  align-content: start;
`;

export const SECTION_FLEX_STYLE = `
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: row;
  gap: var(--masonry-view-card-margin, 8px);
`;

export const FLAT_CONTAINER_STYLE = `
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--masonry-view-card-margin, 8px);
`;
