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

const form = document.getElementById("settings-form");
const resetButton = document.getElementById("reset-button");
const saveStatus = document.getElementById("save-status");
const authMethodSelect = document.getElementById("authMethod");
const connectButton = document.getElementById("connect-button");
const disconnectButton = document.getElementById("disconnect-button");
const authBadge = document.getElementById("auth-badge");
const authSummary = document.getElementById("auth-summary");
const redirectUri = document.getElementById("redirect-uri");
const teamButtons = document.getElementById("team-buttons");
let latestState = null;

initialize().catch((error) => {
  saveStatus.textContent = error instanceof Error ? error.message : String(error);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = readForm();
  const result = await chrome.runtime.sendMessage({ type: "save-settings", settings });
  if (!result?.ok) {
    saveStatus.textContent = result?.error || "Save failed.";
    return;
  }
  latestState = result;
  renderAuthState(result.linearAuth, result.settings);
  saveStatus.textContent = "Settings saved.";
});

resetButton.addEventListener("click", async () => {
  writeForm(DEFAULT_SETTINGS);
  const result = await chrome.runtime.sendMessage({ type: "save-settings", settings: DEFAULT_SETTINGS });
  if (!result?.ok) {
    saveStatus.textContent = result?.error || "Reset failed.";
    return;
  }
  const disconnectResult = await chrome.runtime.sendMessage({ type: "oauth-disconnect" });
  latestState = {
    ...result,
    linearAuth: disconnectResult?.ok ? disconnectResult.linearAuth : result.linearAuth
  };
  renderAuthState(latestState.linearAuth, result.settings);
  await chrome.storage.local.set({ linearDedupe: {} });
  saveStatus.textContent = "Defaults restored.";
});

authMethodSelect.addEventListener("change", () => {
  syncAuthMethodVisibility();
});

connectButton.addEventListener("click", async () => {
  saveStatus.textContent = "Connecting to Linear...";
  const saveResult = await chrome.runtime.sendMessage({ type: "save-settings", settings: readForm() });
  if (!saveResult?.ok) {
    saveStatus.textContent = saveResult?.error || "Could not save settings.";
    return;
  }

  const result = await chrome.runtime.sendMessage({ type: "oauth-connect" });
  if (!result?.ok) {
    saveStatus.textContent = result?.error || "OAuth failed.";
    return;
  }

  latestState = result;
  writeForm(result.settings || readForm());
  renderAuthState(result.linearAuth, result.settings || readForm());
  saveStatus.textContent = "Linear connected.";
});

disconnectButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "oauth-disconnect" });
  if (!result?.ok) {
    saveStatus.textContent = result?.error || "Disconnect failed.";
    return;
  }

  latestState = { ...(latestState || {}), linearAuth: result.linearAuth };
  renderAuthState(result.linearAuth, readForm());
  saveStatus.textContent = "Linear disconnected.";
});

async function initialize() {
  redirectUri.textContent = chrome.identity.getRedirectURL("linear");
  const result = await chrome.runtime.sendMessage({ type: "get-state" });
  if (!result?.ok) {
    throw new Error(result?.error || "Failed to load settings.");
  }
  latestState = result;
  writeForm({ ...DEFAULT_SETTINGS, ...result.settings });
  renderAuthState(result.linearAuth, result.settings);
}

function readForm() {
  return {
    authMethod: document.getElementById("authMethod").value,
    autoCreateLinear: document.getElementById("autoCreateLinear").checked,
    linearApiKey: document.getElementById("linearApiKey").value.trim(),
    linearOauthClientId: document.getElementById("linearOauthClientId").value.trim(),
    linearTeamId: document.getElementById("linearTeamId").value.trim(),
    linearStateId: document.getElementById("linearStateId").value.trim(),
    linearProjectId: document.getElementById("linearProjectId").value.trim(),
    linearLabelIds: document.getElementById("linearLabelIds").value.trim(),
    linearAssigneeId: document.getElementById("linearAssigneeId").value.trim(),
    captureUrlFilter: document.getElementById("captureUrlFilter").value.trim(),
    linearDedupeWindowMinutes: Number(document.getElementById("linearDedupeWindowMinutes").value || DEFAULT_SETTINGS.linearDedupeWindowMinutes),
    linearDedupeIncludeQuery: document.getElementById("linearDedupeIncludeQuery").checked,
    networkHttpErrorStatusMin: Number(document.getElementById("networkHttpErrorStatusMin").value || DEFAULT_SETTINGS.networkHttpErrorStatusMin),
    maxRecords: Number(document.getElementById("maxRecords").value || DEFAULT_SETTINGS.maxRecords)
  };
}

function writeForm(settings) {
  document.getElementById("authMethod").value = settings.authMethod || DEFAULT_SETTINGS.authMethod;
  document.getElementById("autoCreateLinear").checked = Boolean(settings.autoCreateLinear);
  document.getElementById("linearApiKey").value = settings.linearApiKey || "";
  document.getElementById("linearOauthClientId").value = settings.linearOauthClientId || "";
  document.getElementById("linearTeamId").value = settings.linearTeamId || "";
  document.getElementById("linearStateId").value = settings.linearStateId || "";
  document.getElementById("linearProjectId").value = settings.linearProjectId || "";
  document.getElementById("linearLabelIds").value = settings.linearLabelIds || "";
  document.getElementById("linearAssigneeId").value = settings.linearAssigneeId || "";
  document.getElementById("captureUrlFilter").value = settings.captureUrlFilter || "";
  document.getElementById("linearDedupeWindowMinutes").value = settings.linearDedupeWindowMinutes ?? DEFAULT_SETTINGS.linearDedupeWindowMinutes;
  document.getElementById("linearDedupeIncludeQuery").checked = Boolean(settings.linearDedupeIncludeQuery);
  document.getElementById("networkHttpErrorStatusMin").value = settings.networkHttpErrorStatusMin ?? DEFAULT_SETTINGS.networkHttpErrorStatusMin;
  document.getElementById("maxRecords").value = settings.maxRecords ?? DEFAULT_SETTINGS.maxRecords;
  syncAuthMethodVisibility();
}

function renderAuthState(linearAuth, settings) {
  const connected = Boolean(linearAuth?.connected);
  authBadge.textContent = connected ? "Connected" : "Disconnected";
  authBadge.classList.toggle("active", connected);
  syncAuthMethodVisibility();

  if (connected && linearAuth.viewer) {
    const teamCount = Array.isArray(linearAuth.teams) ? linearAuth.teams.length : 0;
    authSummary.textContent = `${linearAuth.viewer.name || "Linear user"} connected${teamCount ? ` across ${teamCount} team${teamCount === 1 ? "" : "s"}` : ""}.`;
  } else if (settings.authMethod === "oauth") {
    authSummary.textContent = "OAuth is ready. Save your client ID, then click Connect with Linear.";
  } else {
    authSummary.textContent = "API key mode is enabled.";
  }

  teamButtons.innerHTML = "";
  const teams = Array.isArray(linearAuth?.teams) ? linearAuth.teams : [];
  for (const team of teams) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip-button";
    button.textContent = team.key ? `${team.name} (${team.key})` : team.name;
    button.addEventListener("click", () => {
      document.getElementById("linearTeamId").value = team.id;
      saveStatus.textContent = `Selected ${team.name}. Save settings to keep it.`;
    });
    teamButtons.appendChild(button);
  }
}

function syncAuthMethodVisibility() {
  const authMethod = document.getElementById("authMethod").value;
  const oauth = authMethod === "oauth";
  document.getElementById("oauth-client-wrap").style.display = oauth ? "" : "none";
  document.getElementById("api-key-wrap").style.display = oauth ? "none" : "";
  connectButton.style.display = oauth ? "" : "none";
  disconnectButton.style.display = oauth ? "" : "none";
}
