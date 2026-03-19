const DEFAULT_SETTINGS = {
  authMethod: "oauth",
  autoCreateLinear: false,
  linearApiKey: "",
  linearOauthClientId: "",
  linearTeamId: "",
  linearStateId: "",
  linearProjectId: "",
  linearLabelIds: "",
  linearAssigneeId: "",
  captureUrlFilter: "",
  linearDedupeWindowMinutes: 60,
  linearDedupeIncludeQuery: false,
  networkHttpErrorStatusMin: 500,
  maxRecords: 250
};

const EMPTY_LINEAR_AUTH = {
  connected: false,
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  scope: "",
  tokenType: "Bearer",
  viewer: null,
  teams: [],
  lastError: ""
};

const inflightLinearCreates = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get([
    "settings",
    "records",
    "linearDedupe",
    "linearAuth"
  ]);

  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    records: Array.isArray(stored.records) ? stored.records : [],
    linearDedupe: stored.linearDedupe || {},
    linearAuth: { ...EMPTY_LINEAR_AUTH, ...(stored.linearAuth || {}) }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }),
    );
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "capture":
      return handleCapture(message.payload, sender);
    case "get-state":
      return getExtensionState();
    case "export-records":
      return exportRecords();
    case "clear-records":
      await chrome.storage.local.set({ records: [], linearDedupe: {} });
      return { cleared: true };
    case "oauth-connect":
      return connectLinearOAuth();
    case "oauth-disconnect":
      return disconnectLinearOAuth();
    case "save-settings":
      return saveSettings(message.settings || {});
    default:
      return { ignored: true };
  }
}

async function handleCapture(payload, sender) {
  const settings = await getSettings();
  const record = buildRecord(payload, sender, settings);

  if (!matchesUrlFilter(record, settings.captureUrlFilter)) {
    return { skipped: true, reason: "url-filter" };
  }

  if (
    record.kind === "network" &&
    record.responseStatus &&
    record.responseStatus < Number(settings.networkHttpErrorStatusMin || DEFAULT_SETTINGS.networkHttpErrorStatusMin)
  ) {
    return { skipped: true, reason: "below-threshold" };
  }

  const saved = await persistRecord(record, settings.maxRecords);
  let linear = null;

  if (settings.autoCreateLinear) {
    linear = await maybeCreateLinearIssue(settings, record);
  }

  return { record, savedCount: saved.length, linear };
}

async function getExtensionState() {
  const {
    records = [],
    settings = DEFAULT_SETTINGS,
    linearAuth = EMPTY_LINEAR_AUTH
  } = await chrome.storage.local.get(["records", "settings", "linearAuth"]);

  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    linearAuth: sanitizeLinearAuth({ ...EMPTY_LINEAR_AUTH, ...linearAuth }),
    recordCount: records.length,
    records: records.slice(-8).reverse()
  };
}

async function saveSettings(partialSettings) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...partialSettings });
  await chrome.storage.local.set({ settings: next });
  return {
    settings: next,
    linearAuth: sanitizeLinearAuth(await getLinearAuth())
  };
}

async function exportRecords() {
  const { records = [] } = await chrome.storage.local.get("records");
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  const blob = new Blob([lines ? `${lines}\n` : ""], {
    type: "application/x-ndjson"
  });
  const url = URL.createObjectURL(blob);
  const filename = `chrome-console-errors-${timestampForFile()}.jsonl`;

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: true
    });
    return { downloadId, count: records.length, filename };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function connectLinearOAuth() {
  const settings = await getSettings();
  if (!settings.linearOauthClientId) {
    throw new Error("Add a Linear OAuth client ID first.");
  }

  const redirectUri = chrome.identity.getRedirectURL("linear");
  const state = randomString(32);
  const codeVerifier = randomString(64);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const scope = "read,issues:create";
  const authorizeUrl = new URL("https://linear.app/oauth/authorize");

  authorizeUrl.searchParams.set("client_id", settings.linearOauthClientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", scope);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const finalUrl = await chrome.identity.launchWebAuthFlow({
    url: authorizeUrl.toString(),
    interactive: true
  });

  if (!finalUrl) {
    throw new Error("Linear OAuth did not return a redirect URL.");
  }

  const redirected = new URL(finalUrl);
  if (redirected.searchParams.get("state") !== state) {
    throw new Error("Linear OAuth state verification failed.");
  }

  const oauthError = redirected.searchParams.get("error");
  if (oauthError) {
    throw new Error(
      redirected.searchParams.get("error_description") || oauthError,
    );
  }

  const code = redirected.searchParams.get("code");
  if (!code) {
    throw new Error("Linear OAuth did not return an authorization code.");
  }

  const tokenResponse = await exchangeOAuthCode({
    clientId: settings.linearOauthClientId,
    code,
    codeVerifier,
    redirectUri
  });

  const linearAuth = await buildLinearAuthFromTokenResponse(tokenResponse);
  await chrome.storage.local.set({ linearAuth });

  const nextSettings = { ...settings };
  if (!nextSettings.linearTeamId && linearAuth.teams.length > 0) {
    nextSettings.linearTeamId = linearAuth.teams[0].id;
    await chrome.storage.local.set({ settings: nextSettings });
  }

  return {
    settings: nextSettings,
    linearAuth: sanitizeLinearAuth(linearAuth)
  };
}

async function disconnectLinearOAuth() {
  const linearAuth = await getLinearAuth();
  const tokenToRevoke = linearAuth.refreshToken || linearAuth.accessToken;

  if (tokenToRevoke) {
    try {
      const body = new URLSearchParams();
      body.set("token", tokenToRevoke);
      if (linearAuth.refreshToken) {
        body.set("token_type_hint", "refresh_token");
      }

      await fetch("https://api.linear.app/oauth/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body
      });
    } catch {
      // Best effort only.
    }
  }

  await chrome.storage.local.set({ linearAuth: { ...EMPTY_LINEAR_AUTH } });
  return {
    linearAuth: sanitizeLinearAuth({ ...EMPTY_LINEAR_AUTH })
  };
}

async function maybeCreateLinearIssue(settings, record) {
  if (!settings.linearTeamId) {
    return { skipped: true, reason: "missing-team" };
  }

  const authorization = await getLinearAuthorizationValue(settings);
  if (!authorization) {
    return { skipped: true, reason: "missing-auth" };
  }

  const inflightKey = `${settings.linearTeamId}:${record.fingerprint}`;
  if (inflightLinearCreates.has(inflightKey)) {
    return inflightLinearCreates.get(inflightKey);
  }

  const pending = maybeCreateLinearIssueInner(
    settings,
    record,
    authorization,
  );
  inflightLinearCreates.set(inflightKey, pending);

  try {
    return await pending;
  } finally {
    inflightLinearCreates.delete(inflightKey);
  }
}

async function maybeCreateLinearIssueInner(
  settings,
  record,
  authorization,
) {
  const dedupeWindowMs =
    Number(
      settings.linearDedupeWindowMinutes ||
        DEFAULT_SETTINGS.linearDedupeWindowMinutes,
    ) *
    60 *
    1000;
  const { linearDedupe = {} } = await chrome.storage.local.get("linearDedupe");
  const lastSeen = linearDedupe[record.fingerprint];
  const now = Date.now();

  if (lastSeen && now - lastSeen < dedupeWindowMs) {
    return { skipped: true, reason: "duplicate" };
  }

  const existingIssue = await findExistingLinearIssue(
    authorization,
    settings.linearTeamId,
    record,
  );
  if (existingIssue) {
    linearDedupe[record.fingerprint] = now;
    await chrome.storage.local.set({ linearDedupe });
    return {
      skipped: true,
      reason: "existing-issue",
      existingIssue
    };
  }

  const input = {
    teamId: settings.linearTeamId,
    title: makeLinearTitle(record),
    description: makeLinearDescription(record)
  };

  if (settings.linearStateId) {
    input.stateId = settings.linearStateId;
  }
  if (settings.linearProjectId) {
    input.projectId = settings.linearProjectId;
  }
  if (settings.linearAssigneeId) {
    input.assigneeId = settings.linearAssigneeId;
  }

  const labelIds = splitCsv(settings.linearLabelIds);
  if (labelIds.length > 0) {
    input.labelIds = labelIds;
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

  const data = await callLinearGraphQL({
    authorization,
    query,
    variables: { input }
  });

  const issue = data.data?.issueCreate?.issue;
  if (!data.data?.issueCreate?.success || !issue) {
    throw new Error("Linear issueCreate returned no issue.");
  }

  linearDedupe[record.fingerprint] = now;
  await chrome.storage.local.set({ linearDedupe });
  return { created: true, ...issue };
}

async function findExistingLinearIssue(authorization, teamId, record) {
  const query = `
    query ExistingIssue($teamId: String!, $title: String!) {
      issues(
        first: 10
        filter: {
          team: { id: { eq: $teamId } }
          title: { eq: $title }
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          description
          state {
            type
          }
        }
      }
    }
  `;

  const data = await callLinearGraphQL({
    authorization,
    query,
    variables: {
      teamId,
      title: makeLinearTitle(record)
    }
  });

  const nodes = Array.isArray(data.data?.issues?.nodes)
    ? data.data.issues.nodes
    : [];

  return (
    nodes.find((issue) => isActiveDuplicateIssue(issue, record)) ||
    null
  );
}

async function buildLinearAuthFromTokenResponse(tokenResponse) {
  const accessToken = tokenResponse.access_token;
  const refreshToken = tokenResponse.refresh_token || "";
  const expiresIn = Number(tokenResponse.expires_in || 0);
  const expiresAt = expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0;
  const scope = Array.isArray(tokenResponse.scope)
    ? tokenResponse.scope.join(" ")
    : String(tokenResponse.scope || "");
  const bootstrap = await fetchLinearViewerAndTeams(`Bearer ${accessToken}`);

  return {
    connected: true,
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    tokenType: tokenResponse.token_type || "Bearer",
    viewer: bootstrap.viewer,
    teams: bootstrap.teams,
    lastError: ""
  };
}

async function fetchLinearViewerAndTeams(authorization) {
  const query = `
    query ExtensionBootstrap {
      viewer {
        id
        name
      }
      teams {
        nodes {
          id
          name
          key
        }
      }
    }
  `;

  const data = await callLinearGraphQL({ authorization, query });
  return {
    viewer: data.data?.viewer || null,
    teams: Array.isArray(data.data?.teams?.nodes) ? data.data.teams.nodes : []
  };
}

async function getLinearAuthorizationValue(settings) {
  if (settings.authMethod === "apiKey") {
    return settings.linearApiKey || "";
  }

  if (settings.authMethod === "oauth") {
    const linearAuth = await ensureValidOAuthToken(settings);
    if (!linearAuth.connected || !linearAuth.accessToken) {
      return "";
    }
    return `Bearer ${linearAuth.accessToken}`;
  }

  return "";
}

async function ensureValidOAuthToken(settings) {
  const linearAuth = await getLinearAuth();
  if (!linearAuth.connected || !linearAuth.accessToken) {
    return linearAuth;
  }

  const now = Date.now();
  if (!linearAuth.expiresAt || linearAuth.expiresAt > now + 60 * 1000) {
    return linearAuth;
  }

  if (!linearAuth.refreshToken || !settings.linearOauthClientId) {
    return linearAuth;
  }

  const refreshed = await refreshOAuthToken(
    settings.linearOauthClientId,
    linearAuth.refreshToken,
  );
  const nextAuth = await buildLinearAuthFromTokenResponse(refreshed);
  await chrome.storage.local.set({ linearAuth: nextAuth });
  return nextAuth;
}

async function exchangeOAuthCode({ clientId, code, codeVerifier, redirectUri }) {
  const body = new URLSearchParams();
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  body.set("code_verifier", codeVerifier);
  body.set("grant_type", "authorization_code");
  return postOAuthForm(body);
}

async function refreshOAuthToken(clientId, refreshToken) {
  const body = new URLSearchParams();
  body.set("refresh_token", refreshToken);
  body.set("client_id", clientId);
  body.set("grant_type", "refresh_token");
  return postOAuthForm(body);
}

async function postOAuthForm(body) {
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      data.error_description || data.error || "Linear OAuth request failed.",
    );
  }
  return data;
}

async function callLinearGraphQL({ authorization, query, variables = {} }) {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    throw new Error(
      data.errors?.[0]?.message ||
        `Linear GraphQL request failed with status ${response.status}.`,
    );
  }

  return data;
}

async function getSettings() {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...settings });
}

async function getLinearAuth() {
  const { linearAuth = EMPTY_LINEAR_AUTH } = await chrome.storage.local.get("linearAuth");
  return { ...EMPTY_LINEAR_AUTH, ...linearAuth };
}

function sanitizeLinearAuth(linearAuth) {
  return {
    connected: Boolean(linearAuth.connected),
    hasRefreshToken: Boolean(linearAuth.refreshToken),
    expiresAt: linearAuth.expiresAt || 0,
    scope: linearAuth.scope || "",
    viewer: linearAuth.viewer || null,
    teams: Array.isArray(linearAuth.teams) ? linearAuth.teams : [],
    lastError: linearAuth.lastError || ""
  };
}

function normalizeSettings(settings) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    authMethod: settings.authMethod === "apiKey" ? "apiKey" : "oauth",
    autoCreateLinear: Boolean(settings.autoCreateLinear),
    linearDedupeIncludeQuery: Boolean(settings.linearDedupeIncludeQuery),
    captureUrlFilter: String(settings.captureUrlFilter || "").trim(),
    networkHttpErrorStatusMin: Number(
      settings.networkHttpErrorStatusMin ||
        DEFAULT_SETTINGS.networkHttpErrorStatusMin,
    ),
    maxRecords: Number(settings.maxRecords || DEFAULT_SETTINGS.maxRecords),
    linearDedupeWindowMinutes: Number(
      settings.linearDedupeWindowMinutes ||
        DEFAULT_SETTINGS.linearDedupeWindowMinutes,
    )
  };
}

async function persistRecord(record, maxRecords) {
  const { records = [] } = await chrome.storage.local.get("records");
  const next = [...records, record];
  const trimmed = next.slice(
    -Math.max(1, Number(maxRecords) || DEFAULT_SETTINGS.maxRecords),
  );
  await chrome.storage.local.set({ records: trimmed });
  return trimmed;
}

function buildRecord(payload, sender, settings) {
  const pageUrl = payload?.pageUrl || sender?.tab?.url || "";
  const pageTitle = payload?.pageTitle || sender?.tab?.title || "";
  const requestUrl = payload?.requestUrl || "";
  const pageRoute = normalizedUrl(pageUrl, settings.linearDedupeIncludeQuery);
  const requestRoute = requestUrl
    ? normalizedUrl(requestUrl, settings.linearDedupeIncludeQuery)
    : "";
  const routeKey = requestRoute || pageRoute || "(unknown-route)";
  const message = truncateText(payload?.message || "(empty)", 5000);
  const stack = truncateText(payload?.stack || "", 5000);
  const record = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    capturedAt: payload?.capturedAt || new Date().toISOString(),
    kind: payload?.kind || "console",
    source: payload?.source || "extension",
    pageUrl,
    pageTitle,
    pageRoute,
    routeKey,
    message,
    stack,
    summary: truncateText(oneLine(message), 220),
    requestUrl,
    requestRoute,
    requestMethod: payload?.requestMethod || "",
    requestResourceType: payload?.requestResourceType || "",
    responseStatus:
      typeof payload?.responseStatus === "number" ? payload.responseStatus : null,
    responseStatusText: payload?.responseStatusText || "",
    networkErrorText: payload?.networkErrorText || "",
    errorType: payload?.errorType || "",
    filename: payload?.filename || "",
    lineno: payload?.lineno || 0,
    colno: payload?.colno || 0,
    tabId: sender?.tab?.id ?? null,
    tabWindowId: sender?.tab?.windowId ?? null
  };

  record.fingerprint = fingerprintFor(record);
  return record;
}

function makeLinearTitle(record) {
  if (record.kind === "network") {
    if (record.responseStatus) {
      return `HTTP ${record.responseStatus} on ${record.routeKey}: ${truncateText(
        `${record.requestMethod || "GET"} ${record.requestRoute || record.requestUrl}`,
        88,
      )}`;
    }

    return `Network failure on ${record.routeKey}: ${truncateText(
      record.networkErrorText || record.message,
      88,
    )}`;
  }

  const page = record.pageRoute || safeUrlHost(record.pageUrl);
  const msg = oneLine(record.message);

  // For opaque/CORS errors, include the source file in the title for differentiation
  if (record.errorType === "CrossOriginOrOpaque" && record.filename) {
    try {
      const fileName = new URL(record.filename).pathname.split("/").pop() || record.filename;
      return `Frontend error on ${page}: ${truncateText(msg, 60)} [${truncateText(fileName, 24)}]`;
    } catch {
      // fall through to default
    }
  }

  return `Frontend error on ${page}: ${truncateText(msg, 88)}`;
}

function makeLinearDescription(record) {
  const parts = [
    "Automatically captured by the Chrome Console Logger extension.",
    "",
    `- Captured at: ${record.capturedAt}`,
    `- Kind: ${record.kind}`,
    `- Source: ${record.source}`,
    `- Page: ${record.pageUrl || "(unknown)"}`,
    `- Page route: ${record.pageRoute || "(unknown)"}`,
    `- Fingerprint: \`${record.fingerprint}\``
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
    parts.push(
      `- Response status: ${record.responseStatus} ${record.responseStatusText}`.trim(),
    );
  }
  if (record.networkErrorText) {
    parts.push(`- Network error: ${record.networkErrorText}`);
  }
  if (record.errorType) {
    parts.push(`- Error type: ${record.errorType}`);
  }
  if (record.filename) {
    parts.push(`- Source file: ${record.filename}`);
  }
  if (record.lineno) {
    parts.push(`- Location: line ${record.lineno}${record.colno ? `:${record.colno}` : ""}`);
  }

  parts.push("", "## Message", "```text", record.message || "(empty)", "```");

  if (record.stack) {
    parts.push("", "## Stack", "```text", record.stack, "```");
  }

  // Add troubleshooting hints for opaque errors
  if (record.errorType === "CrossOriginOrOpaque") {
    parts.push(
      "",
      "## Troubleshooting",
      "This error was captured without a full stack trace (browser stripped it due to CORS).",
      "",
      "**To get full details:**",
      "1. Add `crossorigin` attribute to any `<script>` tags loading from CDNs",
      "2. Ensure the server sends `Access-Control-Allow-Origin` headers for script resources",
      "3. Check the browser DevTools console on the page above — the full error should be visible there",
      `4. The error originates near \`${record.filename || "(unknown)"}:${record.lineno || "?"}:${record.colno || "?"}\``
    );
  }

  return parts.join("\n");
}

function fingerprintFor(record) {
  const source = [
    record.kind,
    record.routeKey,
    record.requestMethod,
    record.responseStatus ?? "",
    oneLine(record.networkErrorText),
    oneLine(record.message),
    oneLine(record.stack),
    // Include filename/line so different errors on the same page get different fingerprints
    record.filename || "",
    record.lineno || "",
    record.colno || ""
  ].join("\n");

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
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
    return truncateText(value, 200);
  }

  return truncateText(value, 200);
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function safeUrlHost(value) {
  try {
    return new URL(value).host;
  } catch {
    return value || "unknown-page";
  }
}

function isActiveDuplicateIssue(issue, record) {
  const stateType = String(issue?.state?.type || "").toLowerCase();
  if (stateType === "completed" || stateType === "canceled") {
    return false;
  }

  const description = String(issue?.description || "");
  const fingerprintToken = `Fingerprint: \`${record.fingerprint}\``;

  return (
    issue?.title === makeLinearTitle(record) &&
    description.includes(fingerprintToken)
  );
}

function matchesUrlFilter(record, captureUrlFilter) {
  const filters = String(captureUrlFilter || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (filters.length === 0) {
    return true;
  }

  const haystacks = [
    record.pageUrl,
    record.pageRoute,
    record.requestUrl,
    record.requestRoute,
    record.routeKey
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());

  return filters.some((filter) => haystacks.some((value) => value.includes(filter)));
}

async function createPkceChallenge(codeVerifier) {
  const bytes = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlEncode(new Uint8Array(digest));
}

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, length);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function timestampForFile() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");
  const second = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}
