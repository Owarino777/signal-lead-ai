"use strict";

(function activateWorkerClient() {
  if (window.__SIGNAL_LEAD_WORKER_CLIENT__) return;
  window.__SIGNAL_LEAD_WORKER_CLIENT__ = true;

  const config = Object.freeze({
    batchSize: 8,
    auditLimit: 20,
    requestTimeoutMs: 30000,
    healthTimeoutMs: 6000,
    concurrency: 4,
    searchBatches: 3,
    searchBudgetPerBatch: 2,
    domainBudgetPerBatch: 4
  });

  window.WORKER_CLIENT = config;

  const fallbackEnrichProspects = enrichProspects;
  const fallbackAuditWebsite = auditWebsite;
  const previousGetSiteStatus = getSiteStatus;

  function getBackendBaseUrl() {
    const value = String(window.SIGNAL_LEAD_BACKEND?.baseUrl || "")
      .trim()
      .replace(/\/+$/, "");

    if (!value) return null;

    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  }

  function describeNetworkError(error) {
    const message = error instanceof Error ? error.message : "Erreur réseau inconnue.";
    if (/failed to fetch|networkerror|load failed|content security policy/i.test(message)) {
      return "Le backend Cloudflare est inaccessible. Recharge la page avec Ctrl + Shift + R.";
    }
    return sanitizeText(message, 300);
  }

  async function callWorker(path, body, timeoutMs = config.requestTimeoutMs) {
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

    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error(`Réponse backend invalide (${response.status}).`);
    if (!response.ok) {
      throw new Error(sanitizeText(payload.error || `Erreur backend ${response.status}.`, 300));
    }
    return payload;
  }

  async function verifyWorkerHealth() {
    const baseUrl = getBackendBaseUrl();
    if (!baseUrl) throw new Error("Backend Cloudflare non configuré.");

    const response = await fetchWithTimeout(`${baseUrl}/health`, {
      method: "GET",
      headers: { Accept: "application/json" }
    }, config.healthTimeoutMs).catch((error) => {
      throw new Error(describeNetworkError(error));
    });

    if (!response.ok) throw new Error(`Backend Cloudflare indisponible (${response.status}).`);
    const payload = await response.json().catch(() => null);
    if (payload?.status !== "ok") throw new Error("Le backend Cloudflare ne répond pas correctement.");
  }

  getSiteStatus = function getWorkerSiteStatus(item) {
    if (item.websiteDiscoveryStatus === "searching") {
      return { label: "Recherche en cours", className: "pending" };
    }
    if (item.websiteDiscoveryStatus === "enrichment_failed") {
      return { label: "Enrichissement indisponible", className: "pending" };
    }
    if (item.websiteDiscoveryStatus === "identity_mismatch") {
      return { label: "Site candidat à confirmer", className: "pending" };
    }
    return previousGetSiteStatus(item);
  };

  function applyContactData(item, result) {
    item.phone = sanitizeText(result?.phone, 60) || item.phone;
    item.email = sanitizeText(result?.email, 180) || item.email;
    item.openingHours = sanitizeText(result?.openingHours, 300) || item.openingHours;
    item.social = Array.isArray(result?.social)
      ? result.social.map((value) => sanitizeText(value, 240)).filter(Boolean).slice(0, 4)
      : item.social;

    if (result?.matchedName || Number.isFinite(result?.placeConfidence)) {
      item.placeMatch = {
        name: sanitizeText(result.matchedName, 220) || null,
        confidence: Number.isFinite(result.placeConfidence) ? result.placeConfidence : null,
        distanceKm: Number.isFinite(result.distanceKm) ? result.distanceKm : null,
        evidence: Array.isArray(result.placeEvidence)
          ? result.placeEvidence.map((value) => sanitizeText(value, 240)).filter(Boolean).slice(0, 6)
          : []
      };
    }
  }

  function clearAutomaticWebsite(item) {
    if (item.websiteSource === "Correction manuelle") return;
    item.website = null;
    item.websiteSource = null;
    item.websiteConfidence = null;
    item.websiteEvidence = [];
    item.websitePageTitle = null;
    item.audit = null;
  }

  function applyWorkerEnrichment(item, result) {
    applyContactData(item, result);

    if (!result?.found) {
      clearAutomaticWebsite(item);
      item.websiteDiscoveryStatus = result?.deferred
        ? "deferred"
        : result?.placeFound
          ? "place_without_website"
          : "not_found";
      updatePriority(item);
      return;
    }

    const website = normalizeUrl(result.website);
    if (!website) {
      item.websiteDiscoveryStatus = result?.placeFound ? "place_without_website" : "not_found";
      updatePriority(item);
      return;
    }

    item.website = website;
    item.websiteDiscoveryStatus = "found";
    item.websiteSource = result.source || "Site validé automatiquement";
    item.websiteConfidence = Number.isFinite(result.confidence) ? result.confidence : null;
    item.websiteEvidence = Array.isArray(result.evidence)
      ? result.evidence.map((value) => sanitizeText(value, 240)).filter(Boolean).slice(0, 6)
      : [];
    item.websitePageTitle = sanitizeText(result.pageTitle, 300) || null;
    item.noSiteConfirmed = false;
    updatePriority(item);
  }

  function rejectMismatchedWebsite(item, audit) {
    item.websiteCandidate = {
      url: item.website,
      source: item.websiteSource,
      confidence: item.websiteConfidence,
      title: audit.title || item.websitePageTitle,
      identity: audit.identity || null
    };
    item.website = null;
    item.websiteSource = null;
    item.websiteConfidence = null;
    item.websiteEvidence = [];
    item.websitePageTitle = null;
    item.websiteDiscoveryStatus = "identity_mismatch";
    item.auditStatus = "identity_mismatch";
    item.auditError = "Le domaine trouvé ne correspond pas assez clairement à cette entreprise.";
    item.audit = null;
    updatePriority(item);
  }

  function mapWorkerAudit(item, audit) {
    const identity = audit.identity || null;
    const manuallyConfirmed = item.websiteSource === "Correction manuelle";

    if (identity && identity.verified === false && !manuallyConfirmed) {
      rejectMismatchedWebsite(item, audit);
      return;
    }

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
      identity: identity
        ? {
            verified: Boolean(identity.verified),
            confidence: Number(identity.confidence) || 0,
            evidence: Array.isArray(identity.evidence) ? identity.evidence.slice(0, 6) : []
          }
        : null,
      screenshot: `${CONFIG.screenshotEndpoint}${encodeURI(audit.finalUrl || item.website)}`
    };

    item.phone = sanitizeText(audit.contacts?.phone, 60) || item.phone;
    item.email = sanitizeText(audit.contacts?.email, 180) || item.email;
    item.auditStatus = "completed";
    item.auditError = null;
    item.websiteDiscoveryStatus = "found";
    if (audit.finalUrl) item.website = normalizeUrl(audit.finalUrl) || item.website;
    updatePriority(item);
  }

  async function enrichBatch(batch, geo, formData, batchIndex) {
    const payload = await callWorker("/api/enrich", {
      geo: {
        latitude: geo.latitude,
        longitude: geo.longitude
      },
      radiusKm: formData.radiusKm,
      segment: formData.category,
      searchBudget: batchIndex < config.searchBatches ? config.searchBudgetPerBatch : 0,
      domainBudget: config.domainBudgetPerBatch,
      businesses: batch.map((item) => ({
        id: item.id,
        name: item.name,
        commercialName: item.commercialName,
        activityLabel: item.activityLabel,
        activityCode: item.activityCode,
        segment: item.segment,
        address: item.address,
        city: item.city,
        phone: item.phone,
        siren: item.siren,
        siret: item.siret,
        latitude: item.latitude,
        longitude: item.longitude
      }))
    });

    const results = new Map(
      (Array.isArray(payload.results) ? payload.results : [])
        .map((result) => [String(result.id), result])
    );

    for (const item of batch) {
      applyWorkerEnrichment(item, results.get(String(item.id)) || { found: false });
    }
  }

  async function auditItem(item) {
    if (!item.website) return;

    item.auditStatus = "running";
    try {
      const payload = await callWorker("/api/audit", {
        url: item.website,
        segment: item.segment,
        business: {
          name: item.name,
          commercialName: item.commercialName,
          city: item.city,
          address: item.address,
          phone: item.phone,
          siren: item.siren,
          siret: item.siret
        }
      }, 24000);
      if (!payload.audit) throw new Error("Audit absent de la réponse.");
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
      return fallbackEnrichProspects(items, geo, formData);
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
      for (const item of items) {
        item.websiteDiscoveryStatus = "enrichment_failed";
        updatePriority(item);
      }
      persistItems();
      render();
      showNotice(describeNetworkError(error), "error");
      setProgress(100, "Recherche terminée : backend indisponible.");
      return;
    }

    const ordered = [...items].sort((left, right) => right.businessScore - left.businessScore);
    const batches = [];
    for (let index = 0; index < ordered.length; index += config.batchSize) {
      batches.push(ordered.slice(index, index + config.batchSize));
    }

    let processed = 0;
    await mapWithConcurrency(batches, 2, async (batch, batchIndex) => {
      try {
        await enrichBatch(batch, geo, formData, batchIndex);
      } catch (error) {
        for (const item of batch) {
          item.websiteDiscoveryStatus = "enrichment_failed";
          updatePriority(item);
        }
        showNotice(describeNetworkError(error), "warning");
      }

      processed += batch.length;
      setProgress(
        48 + Math.round((processed / Math.max(1, items.length)) * 27),
        `Identification des sites (${processed}/${items.length})…`
      );
      persistItems();
      render();
    });

    const auditable = items
      .filter((item) => item.website && item.websiteDiscoveryStatus === "found")
      .sort((left, right) => right.businessScore - left.businessScore)
      .slice(0, config.auditLimit);

    let completed = 0;
    await mapWithConcurrency(auditable, config.concurrency, async (item) => {
      await auditItem(item);
      completed += 1;
      setProgress(
        76 + Math.round((completed / Math.max(1, auditable.length)) * 22),
        `Audit des sites (${completed}/${auditable.length})…`
      );
      persistItems();
      render();
    });

    for (const item of items) updatePriority(item);
    persistItems();
    render();
  };

  auditWebsite = async function auditWebsiteWithWorker(item) {
    if (!getBackendBaseUrl()) return fallbackAuditWebsite(item);
    await verifyWorkerHealth();
    return auditItem(item);
  };
})();
