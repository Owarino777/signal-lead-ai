"use strict";

(function activateProgressiveEnrichment() {
  if (typeof enrichBatchWithWorker !== "function" || typeof verifyWorkerHealth !== "function") {
    return;
  }

  const ENRICHMENT_BATCH_SIZE = 8;
  const ENRICHMENT_CONCURRENCY = 2;
  const MAX_AUTOMATIC_AUDITS = 20;
  const AUDIT_CONCURRENCY = 4;

  applyWorkerEnrichment = function applyStrictWorkerEnrichment(item, result) {
    if (!result?.found) {
      if (item.websiteSource === "Validation automatique du domaine") {
        item.website = null;
        item.websiteSource = null;
        item.websiteConfidence = null;
        item.websiteEvidence = [];
        item.websitePageTitle = null;
        item.audit = null;
        item.auditStatus = null;
        item.auditError = null;
      }

      item.websiteDiscoveryStatus = result?.deferred ? "deferred" : "not_found";
      updatePriority(item);
      return;
    }

    const website = normalizeUrl(result.website);
    if (!website) {
      item.websiteDiscoveryStatus = "not_found";
      updatePriority(item);
      return;
    }

    item.websiteDiscoveryStatus = "found";
    item.website = website;
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

  enrichBatchWithWorker = async function enrichBatchWithStrongIdentity(batch, geo, formData) {
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

  function createBatches(items, size) {
    const batches = [];
    for (let index = 0; index < items.length; index += size) {
      batches.push(items.slice(index, index + size));
    }
    return batches;
  }

  enrichProspects = async function enrichProspectsProgressively(items, geo, formData) {
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

    const orderedItems = [...items].sort(
      (left, right) => right.businessScore - left.businessScore
    );
    const batches = createBatches(orderedItems, ENRICHMENT_BATCH_SIZE);
    let processedCount = 0;
    let failedBatchCount = 0;

    await mapWithConcurrency(
      batches,
      ENRICHMENT_CONCURRENCY,
      async (batch) => {
        try {
          await enrichBatchWithWorker(batch, geo, formData);
        } catch (error) {
          failedBatchCount += 1;
          for (const item of batch) {
            item.websiteDiscoveryStatus = "enrichment_failed";
            updatePriority(item);
          }
          showNotice(describeNetworkError(error), "warning");
        }

        processedCount += batch.length;
        setProgress(
          48 + Math.round((processedCount / Math.max(1, items.length)) * 27),
          `Identification des sites (${processedCount}/${items.length})…`
        );
        persistItems();
        render();
      }
    );

    if (failedBatchCount === batches.length && batches.length > 0) {
      setProgress(100, "Recherche terminée : identification des sites indisponible.");
      return;
    }

    const auditable = items
      .filter((item) => item.website && item.websiteDiscoveryStatus === "found")
      .sort((left, right) => right.businessScore - left.businessScore)
      .slice(0, MAX_AUTOMATIC_AUDITS);

    let completedAudits = 0;
    await mapWithConcurrency(auditable, AUDIT_CONCURRENCY, async (item) => {
      await auditItemWithWorker(item);
      completedAudits += 1;
      setProgress(
        76 + Math.round((completedAudits / Math.max(1, auditable.length)) * 22),
        `Audit des sites validés (${completedAudits}/${auditable.length})…`
      );
      persistItems();
      render();
    });

    for (const item of items) updatePriority(item);
    persistItems();
    render();

    const foundCount = items.filter(
      (item) => item.website && item.websiteDiscoveryStatus === "found"
    ).length;
    const analyzedCount = items.filter((item) => item.auditStatus === "completed").length;

    setProgress(
      100,
      `${items.length} entreprises vérifiées, ${foundCount} site${foundCount > 1 ? "s" : ""} validé${foundCount > 1 ? "s" : ""}, ${analyzedCount} analysé${analyzedCount > 1 ? "s" : ""}.`
    );
  };
})();
