# Chrome Extension

This folder contains a Manifest V3 Chrome extension version of the logger.

## What it captures

- `console.error(...)`
- uncaught `window.onerror`
- `unhandledrejection`
- failed `fetch(...)`
- failed `XMLHttpRequest`
- HTTP `5xx` responses from `fetch` and `XMLHttpRequest`

## What it does with events

- Stores them in `chrome.storage.local`
- Lets you export them as a `.jsonl` file from the popup
- Can optionally create Linear issues automatically

## Load it in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `extension/`

## Configure Linear

Open the extension's **Options** page and choose one of these auth methods:

### OAuth (recommended)

- Create a Linear OAuth app
- Paste the OAuth client ID into the extension
- Add the redirect URL shown by the extension to the Linear app
- Click **Connect with Linear**

### API key

- Paste a Linear API key into the extension
- Add your team ID manually

Both methods support:

- team ID
- optional state/project/assignee/label IDs
- automatic issue creation
- deduping

## Important limitation

Chrome extensions cannot safely append forever to an arbitrary local file on disk without a companion native app. This extension keeps a rolling local log inside Chrome and exports JSONL on demand.

If you need a continuously appended file, use the standalone Node logger in the repo root.
