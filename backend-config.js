"use strict";

window.SIGNAL_LEAD_BACKEND = Object.freeze({
  baseUrl: "https://signal-lead-api.malikcheikhpro14.workers.dev"
});

window.addEventListener("DOMContentLoaded", () => {
  const script = document.createElement("script");
  script.src = "worker-client-v2.js";
  script.defer = true;
  document.head.append(script);
}, { once: true });
