"use strict";

const AUTOMATION = Object.freeze({
  endpoint: location.hostname.endsWith("github.io")
    ? "https://signal-lead-ai.vercel.app/api/enrich-businesses"
    : "/api/enrich-businesses",
  batchSize: 10,
  automaticAuditLimit: 12,
  maxEmployees: 50,
  maxEstablishments: 10,
  maxRevenue: 20_000_000
});

const originalMapCompany = mapCompany;
const originalSearchProspects = searchProspects;

mapCompany = function mapCompanyWithTargeting(company, formData) {
  const prospect = originalMapCompany(company, formData);
  if (!prospect) return null;

  const tooLarge =
    prospect.companyCategory === "GE" ||
    prospect.companyCategory === "ETI" ||
    (prospect.employees !== null && prospect.employees > AUTOMATION.maxEmployees) ||
    prospect.establishments > AUTOMATION.maxEstablishments ||
    (prospect.revenue !== null && prospect.revenue > AUTOMATION.maxRevenue);

  if (tooLarge) return null;
  return prospect;
};

function automationDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callEnrichmentBackend(items) {
  const response = await fetch(AUTOMATION.endpoint, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "strict-origin-when-cross-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businesses: items.map((item) => ({
        id: item.id,
        name: item.name,
        commercialName: item.commercialName,
        address: item.address,
        city: item.city
      }))
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Recherche automatique indisponible (${response.status}).`);
  }
  return Array.isArray(payload.results) ? payload.results : [];
}

function applyPlaceResult(item, result) {
  item.place = {
    found: result.found === true,
    confidence: Number(result.confidence) || 0,
    matchedName: sanitizeText(result.matchedName, 200) || null,
    matchedAddress: sanitizeText(result.matchedAddress, 260) || null,
    phone: sanitizeText(result.phone, 40) || null,
    rating: Number.isFinite(Number(result.rating)) ? Number(result.rating) : null,
    reviewCount: Number.isFinite(Number(result.reviewCount)) ? Number(result.reviewCount) : null,
    businessStatus: sanitizeText(result.businessStatus, 50) || null,
    googleMapsUrl: normalizeUrl(result.googleMapsUrl) || null
  };

  const website = normalizeUrl(result.website);
  if (website && item.place.confidence >= 0.45) {
    item.website = website;
    item.noSiteConfirmed = false;
    item.websiteDiscoveryStatus = "found";
  } else {
    item.websiteDiscoveryStatus = result.found ? "place_without_website" : "not_found";
  }
}

async function auditWebsiteAutomatically(item) {
  if (!item.website || item.audit) return;

  try {
    const params = new URLSearchParams({
      url: item.website,
      screenshot: "true",
      insights: "true"
    });
    const response = await fetchJson(`${CONFIG.microlinkEndpoint}?${params}`, CONFIG.auditTimeoutMs);
    if (response?.status && response.status !== "success") return;

    const payload = response?.data || response;
    const insights = await resolveInsights(payload);
    item.audit = {
      auditedAt: new Date().toISOString(),
      screenshot: normalizeUrl(firstDefined(payload?.screenshot?.url, payload?.screenshot, payload?.image?.url)) || null,
      title: sanitizeText(firstDefined(payload?.title, payload?.data?.title), 240) || null,
      description: sanitizeText(firstDefined(payload?.description, payload?.data?.description), 500) || null,
      performance: recursiveFindScore(insights, ["performance"]),
      seo: recursiveFindScore(insights, ["seo"]),
      accessibility: recursiveFindScore(insights, ["accessibility"]),
      bestPractices: recursiveFindScore(insights, ["best-practices", "bestPractices", "best_practices"]),
      technologies: extractTechnologies({ payload, insights })
    };
    updatePriority(item);
  } catch {
    item.auditStatus = "failed";
  }
}

async function enrichProspectsAutomatically(items) {
  for (let offset = 0; offset < items.length; offset += AUTOMATION.batchSize) {
    const batch = items.slice(offset, offset + AUTOMATION.batchSize);
    setProgress(
      62 + Math.round((offset / Math.max(1, items.length)) * 18),
      `Recherche automatique des sites (${Math.min(offset + batch.length, items.length)}/${items.length})…`
    );

    const results = await callEnrichmentBackend(batch);
    for (const result of results) {
      const item = items.find((candidate) => candidate.id === result.id);
      if (item && !result.error) applyPlaceResult(item, result);
    }
  }

  const toAudit = items
    .filter((item) => item.website)
    .sort((a, b) => b.businessScore - a.businessScore)
    .slice(0, AUTOMATION.automaticAuditLimit);

  for (let index = 0; index < toAudit.length; index += 1) {
    setProgress(
      82 + Math.round((index / Math.max(1, toAudit.length)) * 15),
      `Analyse automatique des sites (${index + 1}/${toAudit.length})…`
    );
    await auditWebsiteAutomatically(toAudit[index]);
    await automationDelay(250);
  }
}

function getAutomatedSiteStatus(item) {
  if (item.noSiteConfirmed) return { label: "Aucun site confirmé", className: "bad" };
  if (item.audit) return { label: "Site trouvé et analysé", className: "good" };
  if (item.website) return { label: "Site trouvé automatiquement", className: "neutral" };
  if (item.websiteDiscoveryStatus === "place_without_website") {
    return { label: "Fiche trouvée, aucun site indiqué", className: "bad" };
  }
  if (item.websiteDiscoveryStatus === "not_found") {
    return { label: "Site non trouvé automatiquement", className: "pending" };
  }
  return { label: "Recherche en attente", className: "pending" };
}

getSiteStatus = getAutomatedSiteStatus;

dom.form.removeEventListener("submit", originalSearchProspects);

searchProspects = async function automatedSearchProspects(event) {
  event.preventDefault();
  if (state.isLoading) return;

  try {
    const formData = readForm();
    setLoading(true);
    setProgress(6, "Localisation de la zone…");
    const geo = await geocodeLocation(formData.location);

    setProgress(22, "Recherche des entreprises actives…");
    const companies = await fetchCompanies(formData, geo);

    setProgress(48, "Exclusion des associations et structures trop importantes…");
    const prospects = deduplicate(
      companies.map((company) => mapCompany(company, formData)).filter(Boolean)
    )
      .sort((a, b) => b.businessScore - a.businessScore)
      .slice(0, formData.limit);

    state.items = prospects;
    render();

    if (prospects.length) {
      try {
        await enrichProspectsAutomatically(prospects);
      } catch (error) {
        showNotice(
          `${error instanceof Error ? error.message : "Enrichissement automatique indisponible."} Les entreprises restent affichées, mais le backend doit être configuré.`,
          "warning"
        );
      }
    }

    persistItems();
    render();
    const foundSites = prospects.filter((item) => item.website).length;
    const auditedSites = prospects.filter((item) => item.audit).length;
    setProgress(
      100,
      `${prospects.length} entreprises ciblées, ${foundSites} sites trouvés et ${auditedSites} analysés.`
    );
    showNotice(
      `${prospects.length} entreprises accessibles conservées. ${foundSites} sites trouvés automatiquement.`,
      "success"
    );
  } catch (error) {
    setProgress(0, "La recherche n’a pas abouti.");
    showNotice(error instanceof Error ? error.message : "Erreur inattendue.", "error");
  } finally {
    setLoading(false);
  }
};

dom.form.addEventListener("submit", searchProspects);
