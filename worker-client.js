"use strict";

const WORKER_CLIENT = Object.freeze({
  batchSize: 10,
  auditLimit: 10,
  requestTimeoutMs: 15000,
  healthTimeoutMs: 6000,
  concurrency: 3
});

const FALLBACK_ENRICH_PROSPECTS = enrichProspects;
const FALLBACK_AUDIT_WEBSITE = auditWebsite;
const PREVIOUS_GET_SITE_STATUS = getSiteStatus;

function getBackendBaseUrl() {
  const value = String(window.SIGNAL_LEAD_BACKEND?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function describeNetworkError(error) {
  const message = error instanceof Error ? error.message : "Erreur réseau inconnue.";
  if (/content security policy|failed to fetch|networkerror|load failed/i.test(message)) {
    return "Le backend Cloudflare est inaccessible depuis cette page. Recharge la dernière version du site avec Ctrl + Shift + R.";
  }
  return sanitizeText(message, 300);
}

async function callWorker(path, body, timeoutMs = WORKER_CLIENT.requestTimeoutMs) {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) throw new Error("Backend Cloudflare non configuré.");

  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, timeoutMs);
  } catch (error) {
    throw new Error(describeNetworkError(error));
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Le backend a renvoyé une réponse invalide (${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(sanitizeText(payload?.error || `Erreur backend ${response.status}.`, 300));
  }
  return payload;
}

async function verifyWorkerHealth() {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) throw new Error("Backend Cloudflare non configuré.");

  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl}/health`, {
      method: "GET",
      headers: { Accept: "application/json" }
    }, WORKER_CLIENT.healthTimeoutMs);
  } catch (error) {
    throw new Error(describeNetworkError(error));
  }

  if (!response.ok) {
    throw new Error(`Backend Cloudflare indisponible (${response.status}).`);
  }

  const payload = await response.json().catch(() => null);
  if (payload?.status !== "ok") {
    throw new Error("Le backend Cloudflare ne répond pas correctement.");
  }
}

getSiteStatus = function getWorkerSiteStatus(item) {
  if (item.websiteDiscoveryStatus === "searching") {
    return { label: "Recherche en cours", className: "pending" };
  }
  if (item.websiteDiscoveryStatus === "enrichment_failed") {
    return { label: "Enrichissement indisponible", className: "pending" };
  }
  return PREVIOUS_GET_SITE_STATUS(item);
};

function applyWorkerEnrichment(item, result) {
  if (!result?.found) {
    item.websiteDiscoveryStatus = "not_found";
    updatePriority(item);
    return;
  }

  item.websiteDiscoveryStatus = result.website ? "found" : "place_without_website";
  item.website = normalizeUrl(result.website) || item.website;
  item.websiteSource = result.source || "OpenStreetMap";
  item.websiteConfidence = Number.isFinite(result.confidence) ? result.confidence : null;
  item.phone = sanitizeText(result.phone, 60) || item.phone;
  item.openingHours = sanitizeText(result.openingHours, 300) || item.openingHours;
  item.social = Array.isArray(result.social)
    ? result.social.map((value) => sanitizeText(value, 240)).filter(Boolean).slice(0, 4)
    : item.social;
  item.osmMatch = {
    name: sanitizeText(result.matchedName, 220),
    confidence: item.websiteConfidence,
    distanceKm: Number.isFinite(result.distanceKm) ? result.distanceKm : null
  };
  updatePriority(item);
}

function mapWorkerAudit(item, audit) {
  item.audit = {
    auditedAt: audit.auditedAt,
    source: "SignalLead Cloudflare Worker",
    fetchSource: "Backend sécurisé",
    finalUrl: audit.finalUrl,
    status: audit.status,
    responseTimeMs: audit.responseTimeMs,
    redirects: audit.redirects,
    title: audit.title,
    description: audit.description,
    technologies: Array.isArray(audit.technologies) ? audit.technologies : [],
    metrics: audit.metrics || {},
    securityHeaders: audit.securityHeaders || {},
    quality: clamp(audit.quality),
    evidence: Array.isArray(audit.evidence) ? audit.evidence.slice(0, 8) : [],
    screenshot: `${CONFIG.screenshotEndpoint}${encodeURI(audit.finalUrl || item.website)}`
  };
  item.auditStatus = "completed";
  item.auditError = null;
  if (audit.finalUrl) item.website = normalizeUrl(audit.finalUrl) || item.website;
  updatePriority(item);
}

async function enrichBatchWithWorker(batch, geo, formData) {
  const payload = await callWorker("/api/enrich", {
    geo: {
      latitude: geo.latitude,
      longitude: geo.longitude
    },
    radiusKm: formData.radiusKm,
    segment: formData.category,
    businesses: batch.map((item) => ({
      id: item.id,
      name: item.name,
      commercialName: item.commercialName,
      city: item.city,
      latitude: item.latitude,
      longitude: item.longitude
    }))
  }, 25000);

  const byId = new Map(
    (Array.isArray(payload?.results) ? payload.results : [])
      .map((result) => [String(result.id), result])
  );

  for (const item of batch) {
    applyWorkerEnrichment(item, byId.get(String(item.id)) || { found: false });
  }
}

async function auditItemWithWorker(item) {
  if (!item.website) return;

  item.auditStatus = "running";
  try {
    const payload = await callWorker("/api/audit", {
      url: item.website,
      segment: item.segment
    }, 15000);
    if (!payload?.audit) throw new Error("Audit absent de la réponse.");
    mapWorkerAudit(item, payload.audit);
  } catch (error) {
    item.auditStatus = "failed";
    item.auditError = describeNetworkError(error);
    item.audit = null;
    updatePriority(item);
  }
}

enrichProspects = async function enrichProspectsWithWorker(items, geo, formData) {
  if (!getBackendBaseUrl()) {
    return FALLBACK_ENRICH_PROSPECTS(items, geo, formData);
  }

  for (const item of items) {
    item.websiteDiscoveryStatus = "searching";
    item.auditStatus = null;
  }
  render();

  try {
    setProgress(46, "Connexion au backend sécurisé…");
    await verifyWorkerHealth();
  } catch (error) {
    const message = describeNetworkError(error);
    for (const item of items) {
      item.websiteDiscoveryStatus = "enrichment_failed";
      updatePriority(item);
    }
    persistItems();
    render();
    showNotice(message, "error");
    setProgress(100, "Recherche terminée : backend indisponible.");
    return;
  }

  const batches = [];
  for (let index = 0; index < items.length; index += WORKER_CLIENT.batchSize) {
    batches.push(items.slice(index, index + WORKER_CLIENT.batchSize));
  }

  let enrichedCount = 0;
  let failedBatches = 0;
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    setProgress(
      48 + Math.round((index / Math.max(1, batches.length)) * 24),
      `Identification sécurisée des sites (${enrichedCount}/${items.length})…`
    );

    try {
      await enrichBatchWithWorker(batch, geo, formData);
    } catch (error) {
      failedBatches += 1;
      for (const item of batch) {
        item.websiteDiscoveryStatus = "enrichment_failed";
        updatePriority(item);
      }
      showNotice(describeNetworkError(error), "warning");
    }

    enrichedCount += batch.length;
    persistItems();
    render();
  }

  const auditable = items
    .filter((item) => item.website)
    .sort((left, right) => right.businessScore - left.businessScore)
    .slice(0, WORKER_CLIENT.auditLimit);

  let completed = 0;
  await mapWithConcurrency(auditable, WORKER_CLIENT.concurrency, async (item) => {
    await auditItemWithWorker(item);
    completed += 1;
    setProgress(
      75 + Math.round((completed / Math.max(1, auditable.length)) * 23),
      `Audit sécurisé des sites (${completed}/${auditable.length})…`
    );
    persistItems();
    render();
  });

  for (const item of items) updatePriority(item);
  persistItems();
  render();

  if (failedBatches === batches.length && batches.length > 0) {
    setProgress(100, "Recherche terminée : enrichissement indisponible.");
  }
};

auditWebsite = async function auditWebsiteWithWorker(item) {
  if (!getBackendBaseUrl()) return FALLBACK_AUDIT_WEBSITE(item);
  await verifyWorkerHealth();
  return auditItemWithWorker(item);
};
