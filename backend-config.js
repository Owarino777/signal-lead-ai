"use strict";

window.SIGNAL_LEAD_BACKEND = Object.freeze({
  baseUrl: "https://signal-lead-api.malikcheikhpro14.workers.dev"
});

(function bootstrapSignalLeadModules() {
  if (window.__SIGNAL_LEAD_MODULE_BOOTSTRAP__) return;
  window.__SIGNAL_LEAD_MODULE_BOOTSTRAP__ = true;

  function findAsset(selector, path) {
    return [...document.querySelectorAll(selector)].find((element) => {
      const attribute = selector.startsWith("script") ? "src" : "href";
      const value = element.getAttribute(attribute) || "";
      return value === path || value.endsWith(`/${path}`);
    }) || null;
  }

  function loadStyle(href) {
    if (findAsset('link[rel="stylesheet"]', href)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = findAsset("script[src]", src);
      if (existing) {
        if (existing.dataset.loaded === "true") {
          resolve();
          return;
        }
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", reject, { once: true });
      document.head.append(script);
    });
  }

  async function start() {
    loadStyle("product-ui.css");

    try {
      await loadScript("commercial-core.js");
      await loadScript("product-ui.js");
    } catch (error) {
      console.error("SignalLead UI bootstrap failed", error);
    }
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
