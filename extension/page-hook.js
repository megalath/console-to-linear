(function installHook() {
  const SOURCE = "chrome-console-linear-extension";
  const FLAG = "__chromeConsoleLinearHookInstalled";

  if (window[FLAG]) {
    return;
  }
  window[FLAG] = true;

  const originalConsoleError = console.error.bind(console);
  const originalFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const originalXHROpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
  const originalXHRSend = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;

  console.error = function patchedConsoleError(...args) {
    emit({
      kind: "console",
      source: "console.error",
      message: args.map(formatValue).join(" "),
      stack: firstStack(args) || ""
    });
    return originalConsoleError(...args);
  };

  window.addEventListener(
    "error",
    (event) => {
      emit({
        kind: "exception",
        source: "window.error",
        message: event.error?.message || event.message || "Window error",
        stack: event.error?.stack || formatLocation(event.filename, event.lineno, event.colno)
      });
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    emit({
      kind: "exception",
      source: "window.unhandledrejection",
      message: formatValue(event.reason),
      stack: extractStack(event.reason)
    });
  });

  if (originalFetch) {
    window.fetch = async function patchedFetch(...args) {
      const request = args[0];
      const init = args[1] || {};
      const requestUrl = absoluteUrl(
        typeof request === "string" ? request : request?.url || "",
      );
      const requestMethod = normalizeMethod(init.method || request?.method || "GET");

      try {
        const response = await originalFetch(...args);
        if (!response.ok && response.status >= 400) {
          emit({
            kind: "network",
            source: "fetch",
            message: `${requestMethod} ${response.url || requestUrl} -> HTTP ${response.status} ${response.statusText || ""}`.trim(),
            requestUrl: response.url || requestUrl,
            requestMethod,
            requestResourceType: "fetch",
            responseStatus: response.status,
            responseStatusText: response.statusText || ""
          });
        }
        return response;
      } catch (error) {
        emit({
          kind: "network",
          source: "fetch",
          message: `${requestMethod} ${requestUrl} -> ${error?.message || "Network request failed"}`,
          stack: error?.stack || "",
          requestUrl,
          requestMethod,
          requestResourceType: "fetch",
          networkErrorText: error?.message || String(error)
        });
        throw error;
      }
    };
  }

  if (originalXHROpen && originalXHRSend) {
    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__chromeConsoleLoggerMeta = {
        method: normalizeMethod(method || "GET"),
        url: absoluteUrl(String(url || ""))
      };
      return originalXHROpen.call(this, method, url, ...rest);
    };

    window.XMLHttpRequest.prototype.send = function patchedSend(...args) {
      const emitFailure = (networkErrorText) => {
        const meta = this.__chromeConsoleLoggerMeta || {};
        emit({
          kind: "network",
          source: "xhr",
          message: `${meta.method || "GET"} ${meta.url || "(unknown request)"} -> ${networkErrorText}`,
          requestUrl: meta.url || "",
          requestMethod: meta.method || "",
          requestResourceType: "xhr",
          networkErrorText
        });
      };

      this.addEventListener(
        "loadend",
        () => {
          const meta = this.__chromeConsoleLoggerMeta || {};
          if (this.status >= 400) {
            emit({
              kind: "network",
              source: "xhr",
              message: `${meta.method || "GET"} ${this.responseURL || meta.url || "(unknown request)"} -> HTTP ${this.status} ${this.statusText || ""}`.trim(),
              requestUrl: this.responseURL || meta.url || "",
              requestMethod: meta.method || "",
              requestResourceType: "xhr",
              responseStatus: this.status,
              responseStatusText: this.statusText || ""
            });
          }
        },
        { once: true }
      );

      this.addEventListener("error", () => emitFailure("XHR network error"), { once: true });
      this.addEventListener("timeout", () => emitFailure("XHR timeout"), { once: true });
      this.addEventListener("abort", () => emitFailure("XHR aborted"), { once: true });

      return originalXHRSend.apply(this, args);
    };
  }

  function emit(payload) {
    window.postMessage(
      {
        source: SOURCE,
        direction: "page-to-extension",
        payload: {
          capturedAt: new Date().toISOString(),
          pageUrl: location.href,
          pageTitle: document.title || "",
          ...payload
        }
      },
      "*"
    );
  }

  function formatValue(value) {
    if (value instanceof Error) {
      return value.stack || `${value.name}: ${value.message}`;
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "undefined") {
      return "undefined";
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function firstStack(values) {
    for (const value of values) {
      const stack = extractStack(value);
      if (stack) {
        return stack;
      }
    }
    return "";
  }

  function extractStack(value) {
    if (value instanceof Error) {
      return value.stack || "";
    }
    if (value && typeof value === "object" && typeof value.stack === "string") {
      return value.stack;
    }
    return "";
  }

  function absoluteUrl(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  }

  function normalizeMethod(value) {
    return String(value || "GET").toUpperCase();
  }

  function formatLocation(fileName, lineNumber, columnNumber) {
    if (!fileName) {
      return "";
    }
    return `${fileName}:${lineNumber || 0}:${columnNumber || 0}`;
  }
})();
