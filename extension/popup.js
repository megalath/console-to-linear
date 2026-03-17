const statusText = document.getElementById("status-text");
const linearStatus = document.getElementById("linear-status");
const recordsList = document.getElementById("records-list");
const exportButton = document.getElementById("export-button");
const clearButton = document.getElementById("clear-button");
const optionsButton = document.getElementById("options-button");

initialize().catch((error) => {
  statusText.textContent = error instanceof Error ? error.message : String(error);
});

exportButton.addEventListener("click", async () => {
  statusText.textContent = "Preparing download...";
  const result = await chrome.runtime.sendMessage({ type: "export-records" });
  if (!result?.ok) {
    statusText.textContent = result?.error || "Export failed.";
    return;
  }
  statusText.textContent = `Downloaded ${result.count} records as ${result.filename}.`;
});

clearButton.addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "clear-records" });
  if (!result?.ok) {
    statusText.textContent = result?.error || "Clear failed.";
    return;
  }
  await renderState();
  statusText.textContent = "Local extension log cleared.";
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function initialize() {
  await renderState();
}

async function renderState() {
  const result = await chrome.runtime.sendMessage({ type: "get-state" });
  if (!result?.ok) {
    throw new Error(result?.error || "Failed to load extension state.");
  }

  const { recordCount, records, settings, linearAuth } = result;
  const hasAuth = settings.authMethod === "oauth"
    ? Boolean(linearAuth?.connected && settings.linearTeamId)
    : Boolean(settings.linearApiKey && settings.linearTeamId);
  const linearEnabled = Boolean(settings.autoCreateLinear && hasAuth);

  statusText.textContent = recordCount === 0
    ? "No errors captured yet."
    : `${recordCount} stored event${recordCount === 1 ? "" : "s"}.`;
  linearStatus.textContent = linearEnabled
    ? settings.authMethod === "oauth"
      ? "Linear OAuth"
      : "Linear API key"
    : "Linear off";
  linearStatus.classList.toggle("active", linearEnabled);

  recordsList.innerHTML = "";
  if (records.length === 0) {
    recordsList.innerHTML = '<p class="empty">Open a page that throws a console error, exception, or HTTP 5xx request.</p>';
    return;
  }

  for (const record of records) {
    const item = document.createElement("article");
    item.className = "record";
    item.innerHTML = `
      <div class="record-top">
        <span class="pill subtle">${escapeHtml(record.kind)}</span>
        <span class="muted">${escapeHtml(shortTime(record.capturedAt))}</span>
      </div>
      <p class="record-title">${escapeHtml(record.summary)}</p>
      <p class="record-meta">${escapeHtml(record.pageRoute || record.pageUrl || "(unknown page)")}</p>
    `;
    recordsList.appendChild(item);
  }
}

function shortTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
