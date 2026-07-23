"use strict";

(function activateSingleRequestEnrichment() {
  if (typeof enrichBatchWithWorker !== "function" || typeof verifyWorkerHealth !== "function") {
    return;
  }

  applyWorkerEnrichment = function applyStrictWorkerEnrichment(item, result) {
    if (!result?.found) {
      if (item.websiteSource === "Validation automatique du domaine") {
        item.website = null;
        item.websiteSource = null;
        item.websiteConfidence = null;
        item.audit = null;
        item.auditStatus = null;
        item.auditError = null;
      }
      item.websiteDiscoveryStatus = result?.deferred ? "deferred" : "not_found";
      updatePriority(item);
      return;
    }

    item.websiteDiscoveryStatus = "found";
    item.website = normalizeUrl(result.website);
    item.websiteSource = result.source || "Validation automatique du domaine";
    item.websiteConfidence = Number.isFinite(result.confidence) ? result.confidence : null;
    item.websiteEvidence = Array.isArray(result.evidence)
      ? result.evidence.map((value) => sanitizeText(value, 240)).filter(Boolean).slice(0, 6)
      : [];
    item.websitePageTitle = sanitizeText(result.pageTitle, 300) || null;
    item.phone = sanitizeText(result.phone, 60) || item.phone;
    item.openingHours = sanitizeText(result.openingHours, 300) || item.openingHours;
    item.social = Array.isArray(result.social)
      ? result.social.map((value) => sanitizeText(value, 240)).filter(Boolean).slice(0, 4)
      : item.social;
    updatePriority(item);
  };

  enrichBatchWithWorker = async function enrichAllWithStrongIdentity(batch, geo, formData) {
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
        activityLabel: item.activityLabel,
        activityCode: item.activityCode,
        segment: item.segment,
        address: item.address,
        city: item.city,
        siren: item.siren,
        siret: item.siret,
        latitude: item.latitude,
        longitude: item.longitude
      }))
    }, 30000);

    const byId = new Map(
      (Array.isArray(payload?.results) ? payload.results : [])
        .map((result) => [String(result.id), result])
    );

    for (const item of batch) {
      applyWorkerEnrichment(item, byId.get(String(item.id)) || { found: false });
    }
  };

  enrichProspects = async function enrichProspectsWithSingleWorkerRequest(items, geo, formData) {
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

    try {
      setProgress(58, `Identification sécurisée des ${items.length} entreprises…`);
      await enrichBatchWithWorker(items, geo, formData);
    } catch (error) {
      const message = describeNetworkError(error);
      for (const item of items) {
        item.websiteDiscoveryStatus = "enrichment_failed";
        updatePriority(item);
      }
      persistItems();
      render();
      showNotice(message, "warning");
      setProgress(100, "Recherche terminée : identification des sites indisponible.");
      return;
    }

    persistItems();
    render();

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
    setProgress(100, `${items.length} entreprises traitées, ${auditable.length} site${auditable.length > 1 ? "s" : ""} validé${auditable.length > 1 ? "s" : ""}.`);
  };
})();
