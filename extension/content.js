const MESSAGE_SOURCE = "chrome-console-linear-extension";

injectHook();

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== MESSAGE_SOURCE || data.direction !== "page-to-extension") {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "capture",
      payload: data.payload
    },
    () => {
      void chrome.runtime.lastError;
    },
  );
});

function injectHook() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-hook.js");
  script.async = false;
  script.dataset.source = MESSAGE_SOURCE;
  script.onload = () => script.remove();
  (document.documentElement || document.head || document.body).appendChild(script);
}
