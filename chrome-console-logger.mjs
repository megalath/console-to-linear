#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULTS = {
  host: "127.0.0.1",
  port: "9222",
  logFile: "./logs/chrome-console-errors.jsonl",
  screenshotDir: "./logs/screenshots",
  pollMs: 3000,
  dedupeWindowMinutes: 60,
  networkHttpErrorStatusMin: 500,
};

loadDotEnv(path.resolve(process.cwd(), ".env"));

const cli = parseArgs(process.argv.slice(2));
const config = {
  host: cli.host ?? process.env.CHROME_DEBUG_HOST ?? DEFAULTS.host,
  port: String(cli.port ?? process.env.CHROME_DEBUG_PORT ?? DEFAULTS.port),
  targetUrl: cli.url ?? process.env.TARGET_URL ?? "",
  logFile: path.resolve(process.cwd(), cli.out ?? process.env.LOG_FILE ?? DEFAULTS.logFile),
  screenshotDir: path.resolve(
    process.cwd(),
    process.env.SCREENSHOT_DIR ?? DEFAULTS.screenshotDir,
  ),
  pollMs: Number(cli.pollMs ?? process.env.POLL_MS ?? DEFAULTS.pollMs),
  captureScreenshot: toBool(process.env.CAPTURE_SCREENSHOT ?? true),
  networkHttpErrorStatusMin: Number(
    process.env.NETWORK_HTTP_ERROR_STATUS_MIN ?? DEFAULTS.networkHttpErrorStatusMin,
  ),
  linearEnabled: toBool(cli.linear ?? process.env.LINEAR_ENABLED ?? false),
  linearApiKey: process.env.LINEAR_API_KEY ?? "",
  linearTeamId: process.env.LINEAR_TEAM_ID ?? "",
  linearStateId: process.env.LINEAR_STATE_ID ?? "",
  linearProjectId: process.env.LINEAR_PROJECT_ID ?? "",
  linearAssigneeId: process.env.LINEAR_ASSIGNEE_ID ?? "",
  linearLabelIds: splitCsv(process.env.LINEAR_LABEL_IDS ?? ""),
  linearDedupeWindowMinutes: Number(
    process.env.LINEAR_DEDUPE_WINDOW_MINUTES ?? DEFAULTS.dedupeWindowMinutes,
  ),
  linearDedupeIncludeQuery: toBool(process.env.LINEAR_DEDUPE_INCLUDE_QUERY ?? false),
};

ensureParentDir(config.logFile);
fs.mkdirSync(config.screenshotDir, { recursive: true });

console.log(`[logger] Writing Chrome errors to ${config.logFile}`);
console.log(`[logger] Screenshots directory: ${config.screenshotDir}`);
console.log(`[logger] Looking for Chrome on http://${config.host}:${config.port}`);
if (config.targetUrl) {
  console.log(`[logger] Target URL filter: ${config.targetUrl}`);
}
if (config.linearEnabled) {
  console.log("[logger] Linear issue creation is enabled.");
}

const state = createState();

process.on("SIGINT", () => {
  console.log("\n[logger] Shutting down.");
  closeSocket(state.ws);
  process.exit(0);
});

await monitorLoop(config, state);

function createState() {
  return {
    ws: null,
    currentTargetId: null,
    currentTargetUrl: null,
    currentPage: {
      url: "",
      title: "",
    },
    connectedOnce: false,
    messageId: 0,
    inflight: new Map(),
    dedupe: new Map(),
    requests: new Map(),
  };
}

async function monitorLoop(config, state) {
  for (;;) {
    try {
      const target = await findTarget(config.host, config.port, config.targetUrl);
      if (!target) {
        const filterText = config.targetUrl ? ` matching "${config.targetUrl}"` : "";
        console.log(`[logger] Waiting for an open Chrome tab${filterText}...`);
        await sleep(config.pollMs);
        continue;
      }

      if (state.currentTargetId !== target.id) {
        console.log(`[logger] Attaching to tab: ${target.title || "(untitled)"} -> ${target.url}`);
      }

      await attachToTarget(config, state, target);
    } catch (error) {
      console.error(`[logger] ${formatError(error)}`);
      closeSocket(state.ws);
      resetConnectionState(state);
      await sleep(config.pollMs);
    }
  }
}

async function attachToTarget(config, state, target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  state.ws = ws;
  state.currentTargetId = target.id;
  state.currentTargetUrl = target.url;
  state.currentPage = {
    url: target.url,
    title: target.title || "",
  };

  await waitForOpen(ws);

  ws.addEventListener("message", async (event) => {
    try {
      const payload = JSON.parse(String(event.data));

      if (payload.id && state.inflight.has(payload.id)) {
        resolveInflight(state, payload);
        return;
      }

      if (!payload.method) {
        return;
      }

      updateStateBeforeRecord(state, payload);

      const record = toRecord(payload, state, config);
      if (!record) {
        cleanupStateAfterRecord(state, payload);
        return;
      }

      if (config.captureScreenshot) {
        const screenshot = await maybeCaptureScreenshot(config, state, record);
        if (screenshot?.path) {
          record.screenshotPath = screenshot.path;
        } else if (screenshot?.error) {
          record.screenshotError = screenshot.error;
        }
      }

      appendRecord(config.logFile, record);
      console.log(`[${record.level}] ${record.summary}`);

      if (config.linearEnabled) {
        const result = await maybeCreateLinearIssue(config, state, record);
        if (result?.created) {
          console.log(`[linear] Created ${result.identifier}: ${result.url}`);
        } else if (result?.skipped) {
          console.log(`[linear] Skipped duplicate issue for fingerprint ${record.fingerprint}`);
        }
      }

      cleanupStateAfterRecord(state, payload);
    } catch (error) {
      console.error(`[logger] Failed to process event: ${formatError(error)}`);
    }
  });

  const closed = new Promise((resolve) => {
    ws.addEventListener("close", () => resolve());
    ws.addEventListener("error", () => resolve());
  });

  await send(ws, state, "Runtime.enable");
  await send(ws, state, "Log.enable");
  await send(ws, state, "Page.enable");
  await send(ws, state, "Network.enable");
  state.connectedOnce = true;
  console.log("[logger] Connected. Waiting for console errors, exceptions, and network failures...");

  await closed;

  console.log("[logger] Chrome tab disconnected. Reconnecting...");
  closeSocket(state.ws);
  resetConnectionState(state);
  await sleep(config.pollMs);
}

function resolveInflight(state, payload) {
  const handlers = state.inflight.get(payload.id);
  state.inflight.delete(payload.id);
  if (!handlers) {
    return;
  }

  if (payload.error) {
    handlers.reject(new Error(payload.error.message || "Chrome debugger command failed"));
  } else {
    handlers.resolve(payload.result);
  }
}

function updateStateBeforeRecord(state, payload) {
  if (payload.method === "Page.frameNavigated") {
    const frame = payload.params?.frame;
    if (frame && !frame.parentId) {
      state.currentPage.url = frame.url || state.currentPage.url;
    }
    return;
  }

  if (payload.method === "Network.requestWillBeSent") {
    const requestId = payload.params?.requestId;
    const request = payload.params?.request;
    if (requestId && request) {
      state.requests.set(requestId, {
        documentURL: payload.params?.documentURL ?? state.currentPage.url,
        method: request.method ?? "",
        requestUrl: request.url ?? "",
        resourceType: payload.params?.type ?? "",
      });
    }
  }
}

function cleanupStateAfterRecord(state, payload) {
  if (
    payload.method === "Network.loadingFinished" ||
    payload.method === "Network.loadingFailed"
  ) {
    const requestId = payload.params?.requestId;
    if (requestId) {
      state.requests.delete(requestId);
    }
  }
}

function toRecord(payload, state, config) {
  const currentPageUrl = state.currentPage.url || state.currentTargetUrl || "";
  const currentPageTitle = state.currentPage.title || "";

  if (payload.method === "Runtime.consoleAPICalled") {
    const type = payload.params?.type;
    if (type !== "error" && type !== "assert") {
      return null;
    }

    const args = payload.params?.args ?? [];
    const stack = payload.params?.stackTrace ? formatStackTrace(payload.params.stackTrace) : "";
    const text = args.map(formatRemoteObject).join(" ");

    return buildRecord(
      {
        kind: "console",
        source: "Runtime.consoleAPICalled",
        level: "error",
        pageUrl: currentPageUrl,
        pageTitle: currentPageTitle,
        text: text || "(console.error with no arguments)",
        stack,
      },
      config,
    );
  }

  if (payload.method === "Runtime.exceptionThrown") {
    const details = payload.params?.exceptionDetails ?? {};
    const description =
      details.exception?.description ||
      details.text ||
      "Uncaught exception";
    const stack = details.stackTrace ? formatStackTrace(details.stackTrace) : "";

    return buildRecord(
      {
        kind: "exception",
        source: "Runtime.exceptionThrown",
        level: "error",
        pageUrl: currentPageUrl,
        pageTitle: currentPageTitle,
        text: description,
        stack,
      },
      config,
    );
  }

  if (payload.method === "Log.entryAdded") {
    const entry = payload.params?.entry;
    if (!entry || entry.level !== "error") {
      return null;
    }

    const text = [entry.source, entry.text].filter(Boolean).join(": ");
    const stack = entry.stackTrace ? formatStackTrace(entry.stackTrace) : "";

    return buildRecord(
      {
        kind: "log",
        source: "Log.entryAdded",
        level: "error",
        pageUrl: entry.url || currentPageUrl,
        pageTitle: currentPageTitle,
        text,
        stack,
      },
      config,
    );
  }

  if (payload.method === "Network.loadingFailed") {
    const requestId = payload.params?.requestId;
    const request = requestId ? state.requests.get(requestId) : null;
    const requestUrl = request?.requestUrl ?? "";
    const errorText = payload.params?.errorText ?? "Network request failed";
    const blockReason = payload.params?.blockedReason ? ` blocked=${payload.params.blockedReason}` : "";
    const canceled = payload.params?.canceled ? " canceled=true" : "";
    const text = `${request?.method || "GET"} ${requestUrl || "(unknown request)"} -> ${errorText}${blockReason}${canceled}`;

    return buildRecord(
      {
        kind: "network",
        source: "Network.loadingFailed",
        level: "error",
        pageUrl: request?.documentURL || currentPageUrl,
        pageTitle: currentPageTitle,
        text,
        stack: "",
        requestUrl,
        requestMethod: request?.method || "",
        requestResourceType: payload.params?.type || request?.resourceType || "",
        networkErrorText: errorText,
      },
      config,
    );
  }

  if (payload.method === "Network.responseReceived") {
    const status = payload.params?.response?.status;
    if (typeof status !== "number" || status < config.networkHttpErrorStatusMin) {
      return null;
    }

    const requestId = payload.params?.requestId;
    const request = requestId ? state.requests.get(requestId) : null;
    const response = payload.params?.response ?? {};
    const requestUrl = response.url || request?.requestUrl || "";
    const requestMethod = request?.method || response.requestHeadersText || "";
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    const text = `${request?.method || "GET"} ${requestUrl} -> HTTP ${status}${statusText}`;

    return buildRecord(
      {
        kind: "network",
        source: "Network.responseReceived",
        level: "error",
        pageUrl: request?.documentURL || currentPageUrl,
        pageTitle: currentPageTitle,
        text,
        stack: "",
        requestUrl,
        requestMethod,
        requestResourceType: payload.params?.type || request?.resourceType || "",
        responseStatus: status,
        responseStatusText: response.statusText || "",
      },
      config,
    );
  }

  return null;
}

function buildRecord(input, config) {
  const pageRoute = normalizedUrl(input.pageUrl, config.linearDedupeIncludeQuery);
  const requestRoute = input.requestUrl
    ? normalizedUrl(input.requestUrl, config.linearDedupeIncludeQuery)
    : "";
  const routeKey = requestRoute || pageRoute || "(unknown-route)";
  const summary = oneLine(input.text, 220);
  const fingerprint = fingerprintFor(
    {
      kind: input.kind,
      routeKey,
      message: input.text,
      stack: input.stack,
      responseStatus: input.responseStatus,
      networkErrorText: input.networkErrorText,
      requestMethod: input.requestMethod,
    },
    config,
  );

  return {
    capturedAt: new Date().toISOString(),
    kind: input.kind,
    source: input.source,
    level: input.level,
    pageUrl: input.pageUrl,
    pageTitle: input.pageTitle,
    pageRoute,
    routeKey,
    summary,
    message: input.text,
    stack: input.stack,
    requestUrl: input.requestUrl || "",
    requestRoute,
    requestMethod: input.requestMethod || "",
    requestResourceType: input.requestResourceType || "",
    responseStatus: input.responseStatus ?? null,
    responseStatusText: input.responseStatusText || "",
    networkErrorText: input.networkErrorText || "",
    fingerprint,
  };
}

async function maybeCaptureScreenshot(config, state, record) {
  if (!state.ws || !isPreferredPageUrl(record.pageUrl)) {
    return null;
  }

  try {
    const result = await send(state.ws, state, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });

    const fileName = `${timestampForFile()}-${record.kind}-${record.fingerprint}.png`;
    const filePath = path.join(config.screenshotDir, sanitizeFileName(fileName));
    fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));
    return { path: filePath };
  } catch (error) {
    return { error: formatError(error) };
  }
}

async function maybeCreateLinearIssue(config, state, record) {
  if (!config.linearApiKey || !config.linearTeamId) {
    console.error("[linear] Missing LINEAR_API_KEY or LINEAR_TEAM_ID; skipping issue creation.");
    return { skipped: true };
  }

  const now = Date.now();
  const dedupeWindowMs = config.linearDedupeWindowMinutes * 60 * 1000;
  const lastSeen = state.dedupe.get(record.fingerprint);
  if (lastSeen && now - lastSeen < dedupeWindowMs) {
    return { skipped: true };
  }

  state.dedupe.set(record.fingerprint, now);

  const input = {
    teamId: config.linearTeamId,
    title: makeLinearTitle(record),
    description: makeLinearDescription(record, config.logFile),
  };

  if (config.linearStateId) {
    input.stateId = config.linearStateId;
  }
  if (config.linearProjectId) {
    input.projectId = config.linearProjectId;
  }
  if (config.linearAssigneeId) {
    input.assigneeId = config.linearAssigneeId;
  }
  if (config.linearLabelIds.length > 0) {
    input.labelIds = config.linearLabelIds;
  }

  const query = `
    mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
        }
      }
    }
  `;

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: config.linearApiKey,
    },
    body: JSON.stringify({ query, variables: { input } }),
  });

  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    throw new Error(`Linear API error: ${JSON.stringify(data.errors || data)}`);
  }

  const issue = data.data?.issueCreate?.issue;
  if (!data.data?.issueCreate?.success || !issue) {
    throw new Error("Linear issueCreate returned no issue.");
  }

  return { created: true, ...issue };
}

function makeLinearTitle(record) {
  if (record.kind === "network") {
    if (record.responseStatus) {
      return `HTTP ${record.responseStatus} on ${record.routeKey}: ${oneLine(record.requestMethod || "GET", 12)} ${oneLine(record.requestRoute || record.requestUrl, 72)}`;
    }

    return `Network failure on ${record.routeKey}: ${oneLine(record.networkErrorText || record.message, 88)}`;
  }

  const hostOrRoute = record.pageRoute || safeUrlHost(record.pageUrl);
  return `Frontend error on ${hostOrRoute}: ${oneLine(record.message, 88)}`;
}

function makeLinearDescription(record, logFile) {
  const parts = [
    "Automatically captured from Chrome DevTools Protocol.",
    "",
    `- Captured at: ${record.capturedAt}`,
    `- Kind: ${record.kind}`,
    `- Source: ${record.source}`,
    `- Page: ${record.pageUrl || "(unknown)"}`,
    `- Page route: ${record.pageRoute || "(unknown)"}`,
    `- Fingerprint: \`${record.fingerprint}\``,
    `- Local log file: \`${logFile}\``,
  ];

  if (record.requestUrl) {
    parts.push(`- Request URL: ${record.requestUrl}`);
  }
  if (record.requestMethod) {
    parts.push(`- Request method: ${record.requestMethod}`);
  }
  if (record.requestResourceType) {
    parts.push(`- Request type: ${record.requestResourceType}`);
  }
  if (record.responseStatus) {
    parts.push(`- Response status: ${record.responseStatus} ${record.responseStatusText}`.trim());
  }
  if (record.networkErrorText) {
    parts.push(`- Network error: ${record.networkErrorText}`);
  }
  if (record.screenshotPath) {
    parts.push(`- Screenshot: \`${record.screenshotPath}\``);
  }
  if (record.screenshotError) {
    parts.push(`- Screenshot error: ${record.screenshotError}`);
  }

  parts.push("", "## Message", "```text", record.message || "(empty)", "```");

  if (record.stack) {
    parts.push("", "## Stack", "```text", record.stack, "```");
  }

  return parts.join("\n");
}

async function findTarget(host, port, targetUrl) {
  const response = await fetch(`http://${host}:${port}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome debugger endpoint returned ${response.status}`);
  }

  const targets = await response.json();
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (targetUrl) {
    return pages.find((target) => target.url.includes(targetUrl)) ?? null;
  }

  const preferred = pages.find((target) => isPreferredPageUrl(target.url));
  return preferred ?? pages[0] ?? null;
}

function send(ws, state, method, params = {}) {
  const id = ++state.messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    state.inflight.set(id, { resolve, reject });
  });
}

function waitForOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket connection failed."));
    };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

function closeSocket(ws) {
  if (!ws) {
    return;
  }

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close();
  }
}

function resetConnectionState(state) {
  state.ws = null;
  state.currentTargetId = null;
  state.currentTargetUrl = null;
  state.currentPage = {
    url: "",
    title: "",
  };
  state.requests.clear();
}

function appendRecord(logFile, record) {
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function formatRemoteObject(arg) {
  if (!arg) {
    return "";
  }

  if ("value" in arg && arg.value !== undefined) {
    return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  }

  if (arg.unserializableValue) {
    return arg.unserializableValue;
  }

  if (arg.description) {
    return arg.description;
  }

  if (arg.preview?.properties?.length) {
    const pairs = arg.preview.properties.map((entry) => `${entry.name}: ${entry.value}`);
    return `{ ${pairs.join(", ")} }`;
  }

  return arg.type || "[unknown]";
}

function formatStackTrace(stackTrace) {
  const frames = stackTrace.callFrames ?? [];
  return frames
    .map(
      (frame) =>
        `${frame.functionName || "(anonymous)"} @ ${frame.url || "(inline)"}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`,
    )
    .join("\n");
}

function fingerprintFor(input) {
  const source = [
    input.kind,
    input.routeKey,
    input.requestMethod,
    input.responseStatus ?? "",
    oneLine(input.networkErrorText, 200),
    oneLine(input.message, 500),
    oneLine(input.stack, 500),
  ].join("\n");

  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}

function normalizedUrl(value, includeQuery) {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return includeQuery
        ? `${url.origin}${url.pathname}${url.search}`
        : `${url.origin}${url.pathname}`;
    }

    if (url.protocol === "file:") {
      return url.pathname;
    }
  } catch {
    return oneLine(value, 200);
  }

  return oneLine(value, 200);
}

function oneLine(text, maxLength) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function safeUrlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value || "unknown-page";
  }
}

function splitCsv(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isPreferredPageUrl(url) {
  return /^(https?:|file:|data:)/.test(url);
}

function sanitizeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function timestampForFile() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  const millis = String(now.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}-${hour}${minute}${second}-${millis}`;
}

function toBool(value) {
  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (current === "--url") {
      parsed.url = argv[++i];
    } else if (current === "--out") {
      parsed.out = argv[++i];
    } else if (current === "--port") {
      parsed.port = argv[++i];
    } else if (current === "--host") {
      parsed.host = argv[++i];
    } else if (current === "--poll-ms") {
      parsed.pollMs = argv[++i];
    } else if (current === "--linear") {
      parsed.linear = true;
    } else if (current === "--help" || current === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
Usage:
  node chrome-console-logger.mjs [options]

Options:
  --url <substring>   Only attach to a tab whose URL contains this text.
  --out <path>        JSONL log file path. Default: ./logs/chrome-console-errors.jsonl
  --host <host>       Chrome debugger host. Default: 127.0.0.1
  --port <port>       Chrome debugger port. Default: 9222
  --poll-ms <ms>      How often to retry when Chrome/tab is unavailable. Default: 3000
  --linear            Enable Linear issue creation for this run.
  -h, --help          Show help.
`);
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    const value = stripQuotes(rawValue);

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
