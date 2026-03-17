# Chrome Console Logger + Linear

This folder now contains two ways to capture Chrome-side errors:

- a standalone Node utility that listens through Chrome DevTools and appends to a local JSONL file
- a Chrome extension that captures page errors natively, stores them in Chrome, exports JSONL on demand, and can auto-create Linear issues through either OAuth or an API key

No external packages are required, so there is no `npm install` step.

## What it does

- Captures `console.error(...)`, uncaught exceptions, and network failures.
- Dedupes by route-aware fingerprints before creating Linear issues.
- Can include screenshots in the standalone logger.
- Gives you either a true append-only local file workflow or a native extension workflow.

## Choose a mode

### 1. Standalone logger

Use this if you want a continuously appended local file on disk.

- File logger: `chrome-console-logger.mjs`
- Launcher: `launch-chrome-debug.sh`

### 2. Chrome extension

Use this if you want native browser capture without launching Chrome in remote-debug mode.

- Extension folder: `extension/`
- Popup: export JSONL, clear local log, open settings
- Options page: configure Linear OAuth or API-key auth, auto-create, and capture thresholds
- URL filter: limit capture to a hostname, route fragment, or other URL substring

## Files

- `chrome-console-logger.mjs`: the logger and optional Linear integration.
- `launch-chrome-debug.sh`: starts a separate Chrome instance with remote debugging enabled.
- `.env.example`: configuration template.

## Quick start

```bash
chmod +x ./launch-chrome-debug.sh
cp .env.example .env
./launch-chrome-debug.sh http://localhost:3000
npm run logger
```

If your page is not `http://localhost:3000`, update `TARGET_URL` in `.env` or pass `--url`.

## Chrome extension quick start

1. Open `chrome://extensions`
2. Turn on Developer mode
3. Click Load unpacked
4. Select `/Users/anthonylatham/Product/repos/toys/extension`
5. Open the extension Options page and add your Linear settings if you want auto-create enabled

The extension stores records in `chrome.storage.local` and exports them as JSONL from the popup.

OAuth is the recommended setup. You paste a Linear OAuth client ID once, add the shown redirect URL to your Linear OAuth app, and then use the Connect button in the extension.

## Linear setup

Set these in `.env`:

```bash
LINEAR_ENABLED=true
LINEAR_API_KEY=lin_api_xxx
LINEAR_TEAM_ID=your_team_uuid
```

Optional extras:

- `LINEAR_STATE_ID`
- `LINEAR_PROJECT_ID`
- `LINEAR_LABEL_IDS`
- `LINEAR_ASSIGNEE_ID`
- `LINEAR_DEDUPE_WINDOW_MINUTES`

Then run:

```bash
npm run logger -- --linear
```

## Output format

Standalone logs are written to `./logs/chrome-console-errors.jsonl` by default. Each line is a JSON object with:

- capture time
- page URL and title
- source event type
- message
- stack trace
- fingerprint for deduping
- optional screenshot path

The extension keeps the same basic shape in `chrome.storage.local` and exports those records as JSONL.

## Notes

- This uses a separate Chrome profile in `./.chrome-debug-profile` so it does not interfere with your normal browser session.
- If you want to attach to a specific page, set `TARGET_URL` to a substring such as `localhost:3000/dashboard`.
- Linear issue creation uses the official GraphQL endpoint at `https://api.linear.app/graphql`.
- Chrome extensions cannot safely append forever to an arbitrary local file without a native helper, so the extension stores locally and exports on demand. Use the standalone logger if you want an always-growing file.
- The extension cannot use Linear OAuth with zero configuration, because Linear requires a registered OAuth app and approved redirect URL. After that one-time setup, the extension flow is click-to-connect.
