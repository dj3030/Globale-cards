# Global Cards

A custom [Home Assistant](https://www.home-assistant.io) Lovelace card that lets you define cards once on a central dashboard and reuse them across multiple dashboards — without duplicating YAML.

## What it does

- **Popup mode** *(default)*: Loads cards (e.g. Bubble Card pop-ups) from a source dashboard into the current dashboard. Pop-ups become accessible via their hash (e.g. `#my-popup`) from anywhere on the page.
- **Inline mode**: Renders cards visually in place — useful for global headers or shared UI sections.

The card is completely invisible when not in edit mode and takes no space in the dashboard layout.

-----

## Installation

### HACS (recommended)

1. Open HACS → Frontend → **+ Explore & Download Repositories**
1. Search for **Global Cards Card** and download it
1. Refresh your browser

### Manual

1. Download `global-cards.js` from the [latest release](../../releases/latest)
1. Copy it to `/config/www/global-cards.js`
1. Add it as a resource in Home Assistant:
- **Settings → Dashboards → Resources → Add resource**
- URL: `/local/global-cards.js`
- Type: `JavaScript module`
1. Hard refresh your browser (`Ctrl+Shift+R` / `Cmd+Shift+R`)

-----

## Setup

### 1. Create a source dashboard

Create a dashboard in Home Assistant (e.g. `Global Cards`) and add the cards you want to share — Bubble Card pop-ups, headers, or any other cards.

Find the dashboard’s **url_path** under **Settings → Dashboards → (your dashboard) → edit**.

### 2. Add the card to other dashboards

```yaml
type: custom:global-cards
source_dashboard: global-cards-dashboard   # url_path of your source dashboard
source_view: popups                         # optional: specific view path or title
```

-----

## Configuration

|Option            |Required|Default  |Description                                   |
|------------------|--------|---------|----------------------------------------------|
|`source_dashboard`|✅       |–        |`url_path` of the dashboard to load cards from|
|`source_view`     |❌       |all views|Path or title of a specific view to load from |
|`mode`            |❌       |`popup`  |`popup` (invisible) or `inline` (visible)     |

-----

## Examples

### Global Bubble Card pop-ups

Define your bubble card pop-ups once on a `global-cards` dashboard:

```yaml
# On your "global-cards" dashboard
type: custom:bubble-card
card_type: pop-up
hash: "#lights"
name: Lights
```

Then on any other dashboard:

```yaml
type: custom:global-cards
source_dashboard: global-cards-dashboard
source_view: popups
```

Call the pop-up from a button:

```yaml
type: custom:bubble-card
card_type: button
button_type: name
button_action:
  tap_action:
    action: navigate
    navigation_path: "#lights"
```

-----

### Global header (inline mode)

Define a header view once with your preferred sections layout, then embed it on every dashboard:

```yaml
type: custom:global-cards
source_dashboard: global-cards-dashboard
source_view: header
mode: inline
```

-----

## Edit mode

In edit mode, the card shows a status indicator with the source dashboard, view, and number of loaded cards. Outside edit mode it is completely invisible and takes no space in the layout.

-----
