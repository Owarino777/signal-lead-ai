"use strict";

window.SIGNAL_LEAD_BACKEND = Object.freeze({
  baseUrl: "https://signal-lead-api.malikcheikhpro14.workers.dev"
});

function appendStylesheetOnce(href) {
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = href;
  document.head.append(stylesheet);
}

function appendScriptOnce(src, onLoad) {
  const existing = [...document.scripts].find((script) => {
    const value = script.getAttribute("src") || "";
    return value === src || value.endsWith(`/${src}`);
  });

  if (existing) {
    if (onLoad) {
      if (existing.dataset.loaded === "true") onLoad();
      else existing.addEventListener("load", onLoad, { once: true });
    }
    return existing;
  }

  const script = document.createElement("script");
  script.src = src;
  script.addEventListener("load", () => {
    script.dataset.loaded = "true";
  }, { once: true });
  if (onLoad) script.addEventListener("load", onLoad, { once: true });
  document.head.append(script);
  return script;
}

function loadSignalLeadModules() {
  if (window.__SIGNAL_LEAD_MODULES_LOADING__) return;
  window.__SIGNAL_LEAD_MODULES_LOADING__ = true;

  appendStylesheetOnce("commercial-intelligence.css");
  appendStylesheetOnce("product-ui.css");

  const loadCommercialUi = () => {
    appendScriptOnce("commercial-intelligence.js", () => {
      appendScriptOnce("runtime-fixes.js", () => {
        appendScriptOnce("product-ui.js");
      });
    });
  };

  if (typeof WORKER_CLIENT !== "undefined") {
    loadCommercialUi();
    return;
  }

  appendScriptOnce("worker-client-v2.js", loadCommercialUi);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", loadSignalLeadModules, { once: true });
} else {
  loadSignalLeadModules();
}
