"use strict";

window.SIGNAL_LEAD_BACKEND = Object.freeze({
  baseUrl: "https://signal-lead-api.malikcheikhpro14.workers.dev"
});

function appendStylesheet(href) {
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = href;
  document.head.append(stylesheet);
}

function appendScript(src, onLoad) {
  const script = document.createElement("script");
  script.src = src;
  if (onLoad) script.addEventListener("load", onLoad, { once: true });
  document.head.append(script);
}

window.addEventListener("DOMContentLoaded", () => {
  appendStylesheet("commercial-intelligence.css");
  appendStylesheet("product-ui.css");

  appendScript("worker-client-v2.js", () => {
    appendScript("commercial-intelligence.js", () => {
      appendScript("product-ui.js");
    });
  });
}, { once: true });
