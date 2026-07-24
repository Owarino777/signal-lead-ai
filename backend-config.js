"use strict";

window.SIGNAL_LEAD_BACKEND = Object.freeze({
  baseUrl: "https://signal-lead-api.malikcheikhpro14.workers.dev"
});

window.addEventListener("DOMContentLoaded", () => {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = "commercial-intelligence.css";
  document.head.append(stylesheet);

  const enrichmentScript = document.createElement("script");
  enrichmentScript.src = "worker-client-v2.js";
  enrichmentScript.addEventListener("load", () => {
    const intelligenceScript = document.createElement("script");
    intelligenceScript.src = "commercial-intelligence.js";
    document.head.append(intelligenceScript);
  }, { once: true });
  document.head.append(enrichmentScript);
}, { once: true });
