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
      // Skip known harmless browser noise
      const msg = event.error?.message || event.message || "";
      if (isHarmlessError(msg)) {
        return;
      }

      // When event.error exists, we have the real Error object (same-origin script)
      // When it's null, the browser stripped it (CORS / "Script error")
      const hasRealError = event.error instanceof Error;
      const message = hasRealError
        ? event.error.message
        : (event.message && event.message !== "Script error." && event.message !== "Script error")
          ? event.message
          : buildContextualMessage(event);
      const stack = hasRealError
        ? (event.error.stack || "")
        : formatLocation(event.filename, event.lineno, event.colno);

      emit({
        kind: "exception",
        source: "window.error",
        message,
        stack,
        errorType: hasRealError ? (event.error.name || "Error") : "CrossOriginOrOpaque",
        filename: event.filename || "",
        lineno: event.lineno || 0,
        colno: event.colno || 0
      });
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    const msg = formatValue(event.reason);
    if (isHarmlessError(msg)) {
      return;
    }

    emit({
      kind: "exception",
      source: "window.unhandledrejection",
      message: msg,
      stack: extractStack(event.reason),
      errorType: event.reason instanceof Error ? (event.reason.name || "Error") : "UnknownRejection"
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

  /**
   * Build a more useful message when the browser gives us "Script error" / null error.
   * We include the location info so different errors on the same page get different fingerprints.
   */
  function buildContextualMessage(event) {
    const parts = ["Uncaught error (cross-origin or opaque)"];
    if (event.filename) {
      // Extract just the filename/path portion for readability
      try {
        const url = new URL(event.filename);
        parts.push(`in ${url.pathname.split("/").pop() || url.pathname}`);
      } catch {
        parts.push(`in ${event.filename}`);
      }
    }
    if (event.lineno) {
      parts.push(`at line ${event.lineno}${event.colno ? `:${event.colno}` : ""}`);
    }
    return parts.join(" ");
  }

  /**
   * Filter out known harmless browser errors that aren't real bugs.
   */
  function isHarmlessError(message) {
    if (!message) return false;
    const msg = String(message);
    const HARMLESS_PATTERNS = [
      // Browser resize observer noise
      "ResizeObserver loop",
      // Extension errors from other extensions
      "chrome-extension://",
      "moz-extension://",
      // React dev-only warnings (not real errors)
      "Warning: ",
      // Network errors already captured by fetch/XHR hooks
      "Failed to fetch",
      "NetworkError when attempting to access",
      "Load failed",
      // Browser permission prompts
      "NotAllowedError",
      // Canceled navigation
      "AbortError",
    ];
    return HARMLESS_PATTERNS.some(pattern => msg.includes(pattern));
  }
})();
