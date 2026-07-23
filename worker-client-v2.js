"use strict";

(function activateSingleRequestEnrichment() {
  if (typeof enrichBatchWithWorker !== "function" || typeof verifyWorkerHealth !== "function") {
    return;
  }

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
      setProgress(100, "Recherche terminée : OpenStreetMap est temporairement indisponible.");
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
    setProgress(100, `${items.length} entreprises enrichies, ${auditable.length} site${auditable.length > 1 ? "s" : ""} à analyser.`);
  };
})();
