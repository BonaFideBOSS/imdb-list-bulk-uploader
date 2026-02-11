# IMDb List Bulk Uploader

A Tampermonkey userscript that adds a bulk upload panel to any IMDb list edit page. Add hundreds of titles (with optional descriptions) in one go — via CSV file or pasted text.

![IMDb List Bulk Uploader](https://img.shields.io/badge/IMDb-Bulk_Uploader-f5c518?style=for-the-badge&logo=imdb&logoColor=000)

## Features

- **Two input modes** — paste data directly or upload a `.csv` / `.txt` file
- **Optional descriptions** — set a custom description per item using IMDb's markup syntax
- **Rate-limit protection** — configurable delay between API requests (1s – 30s)
- **Live progress** — real-time progress bar and color-coded log
- **Cancel anytime** — abort mid-upload; items already added are kept
- **CSV template download** — one-click download of a ready-to-fill template
- **Zero configuration** — uses your existing IMDb session; no API keys or tokens needed
- **Works on any list** — automatically detects the list ID from the URL

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Click the link below to install the script:

   **[Install IMDb List Bulk Uploader](../../raw/refs/heads/main/imdb-list-bulk-uploader.user.js)**

   _Or manually: open Tampermonkey dashboard → `+` (Create new script) → paste the contents of `imdb-bulk-uploader.user.js` → Save._

4. Go to any IMDb list edit page (e.g. `https://www.imdb.com/list/ls123456789/edit/`)
5. The **Bulk Upload** card will appear above the "Add a title to this list" section

> **Note:** You must be logged in to IMDb for the script to work. It uses your browser's existing session cookies to authenticate API requests.

## Usage

### Preparing your data

Each row needs an IMDb **const ID** (e.g. `tt0111161` for a title, `nm0000151` for a person). The **description** column is optional.

#### Format 1 — CSV with header

```csv
id,description
tt0111161,"[h2]Worldwide Lifetime Gross: [b]$2,923,710,708[/b][/h2]"
tt4154796,"[h2]Worldwide Lifetime Gross: [b]$2,799,439,100[/b][/h2]"
tt1630029,
```

#### Format 2 — IDs only (no header needed)

```
tt0111161
tt4154796
tt1630029
```

#### Format 3 — Mixed (some with descriptions, some without)

```csv
id,description
tt0111161,"A great movie"
tt4154796,
tt1630029
```

### Uploading

1. **Paste Data** tab — type or paste your data directly into the textarea
2. **Upload CSV** tab — click the dashed area to select a `.csv` or `.txt` file
3. _(Optional)_ Check **Delay between requests** and pick an interval if you're uploading a large batch
4. Click **Start Upload**
5. Watch the progress bar and log as each item is added
6. When finished, click **Refresh page to see changes**

### Description syntax

IMDb list descriptions support a BBCode-like markup:

| Syntax                                     | Result    |
| ------------------------------------------ | --------- |
| `[b]bold[/b]`                              | **bold**  |
| `[i]italic[/i]`                            | _italic_  |
| `[h2]heading[/h2]`                         | Heading   |
| `[link=/title/tt0111161/]link text[/link]` | Hyperlink |

### Delay option

IMDb may rate-limit rapid API calls. If you're uploading a large number of items (50+), enabling a delay is recommended:

| Batch size     | Suggested delay |
| -------------- | --------------- |
| < 50 items     | No delay needed |
| 50 – 200 items | 1 – 3 seconds   |
| 200+ items     | 5 – 10 seconds  |

## How it works

The script calls IMDb's own GraphQL API (`api.graphql.imdb.com`) — the same endpoint the website uses internally. For each item it:

1. Sends an `AddConstToList` mutation to add the title/name to the list
2. If a description is provided, sends an `EditListItemDescription` mutation using the `itemId` returned from step 1

Authentication is handled automatically via your browser cookies (`credentials: "include"`), so no tokens are hardcoded or exposed.

## Compatibility

- **Browser:** Chrome, Firefox, Edge, or any Chromium-based browser
- **Extension:** [Tampermonkey](https://www.tampermonkey.net/) (recommended) or [Greasemonkey](https://www.greasespot.net/)
- **IMDb:** Works on any list edit page (`/list/ls*/edit*`)

## License

[MIT](LICENSE)
