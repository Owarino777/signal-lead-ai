"use strict";

const FAST_ENRICHMENT = Object.freeze({
  overpassEndpoint: "https://overpass.kumi.systems/api/interpreter",
  dnsEndpoint: "https://cloudflare-dns.com/dns-query",
  overpassTimeoutMs: 8000,
  dnsTimeoutMs: 2500,
  proxyTimeoutMs: 6500,
  domainProspectLimit: 8,
  auditLimit: 8,
  domainCandidatesPerProspect: 3,
  concurrency: 2
});

const ORIGINAL_CONTAINS_EXCLUDED_BRAND = containsExcludedBrand;

containsExcludedBrand = function containsExcludedBrandFastPatch(...values) {
  if (ORIGINAL_CONTAINS_EXCLUDED_BRAND(...values)) return true;
  const normalized = normalizeWords(values.filter(Boolean).join(" "));
  return ["bchef", "black and white burger", "chamas tacos", "nabab kebab"]
    .some((brand) => normalized.includes(normalizeWords(brand)));
};

fetchOverpass = async function fetchOverpassThroughSingleProxy(query) {
  const overpassUrl = `${FAST_ENRICHMENT.overpassEndpoint}?${new URLSearchParams({ data: query })}`;
  const proxyUrl = `${CONFIG.allOriginsEndpoint}?${new URLSearchParams({ url: overpassUrl })}`;
  const response = await fetchWithTimeout(proxyUrl, {
    headers: { Accept: "application/json,text/plain;q=0.9" }
  }, FAST_ENRICHMENT.overpassTimeoutMs);

  if (!response.ok) {
    throw new Error(`OpenStreetMap est temporairement indisponible (${response.status}).`);
  }

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("OpenStreetMap a renvoyé une réponse inexploitable.");
  }
};

buildDomainCandidates = function buildReducedDomainCandidates(item) {
  const primaryName = slugify(item.commercialName || item.name);
  const city = slugify(item.city);
  if (primaryName.length < 4) return [];

  const candidates = [
    `${primaryName}.fr`,
    city ? `${primaryName}-${city}.fr` : null,
    `${primaryName}.com`
  ].filter(Boolean);

  return [...new Set(candidates)]
    .slice(0, FAST_ENRICHMENT.domainCandidatesPerProspect)
    .map((hostname) => `https://${hostname}/`);
};

async function dnsHostnameExists(hostname) {
  const params = new URLSearchParams({
    name: hostname,
    type: "A"
  });

  try {
    const response = await fetchWithTimeout(
      `${FAST_ENRICHMENT.dnsEndpoint}?${params}`,
      { headers: { Accept: "application/dns-json" } },
      FAST_ENRICHMENT.dnsTimeoutMs
    );
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.Status === 0 && Array.isArray(payload.Answer) && payload.Answer.some((answer) => {
      const type = Number(answer?.type);
      return type === 1 || type === 5 || type === 28;
    });
  } catch {
    return false;
  }
}

fetchWebsiteContent = async function fetchWebsiteContentFast(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error("URL invalide.");

  const allOriginsUrl = `${CONFIG.allOriginsEndpoint}?${new URLSearchParams({ url: normalized })}`;
  try {
    const response = await fetchWithTimeout(
      allOriginsUrl,
      { headers: { Accept: "text/html,text/plain;q=0.9" } },
      FAST_ENRICHMENT.proxyTimeoutMs
    );
    if (response.ok) {
      const html = await response.text();
      if (html.length > 100) {
        return {
          content: html.slice(0, 1_500_000),
          format: /<!doctype html|<html[\s>]/i.test(html) ? "html" : "text",
          source: "AllOrigins"
        };
      }
    }
  } catch {
    // Continue with the reader fallback.
  }

  const readerUrl = `${CONFIG.jinaEndpoint}${normalized.replace(/^https?:\/\//i, "")}`;
  const response = await fetchWithTimeout(
    readerUrl,
    { headers: { Accept: "text/plain" } },
    FAST_ENRICHMENT.proxyTimeoutMs
  );
  if (!response.ok) throw new Error(`Lecture du site indisponible (${response.status}).`);
  const text = await response.text();
  if (text.length < 80) throw new Error("Contenu du site insuffisant.");
  return {
    content: text.slice(0, 800_000),
    format: "text",
    source: "Jina Reader"
  };
};

discoverDomainForItem = async function discoverDomainWithDnsPreflight(item) {
  for (const candidate of buildDomainCandidates(item)) {
    const hostname = new URL(candidate).hostname;
    const exists = await dnsHostnameExists(hostname);
    if (!exists) continue;

    try {
      const document = await fetchWebsiteContent(candidate);
      const confidence = domainIdentityScore(item, candidate, document.content);
      if (confidence >= 0.52) {
        item.website = candidate;
        item.websiteSource = "Domaine détecté automatiquement";
        item.websiteConfidence = confidence;
        item.websiteDiscoveryStatus = "found";
        return true;
      }
    } catch {
      // A registered domain may still refuse automated reading.
    }
  }

  item.websiteDiscoveryStatus = "not_found";
  return false;
};

const ORIGINAL_GET_SITE_STATUS = getSiteStatus;

getSiteStatus = function getFastSiteStatus(item) {
  if (item.websiteDiscoveryStatus === "deferred") {
    return { label: "Analyse différée", className: "pending" };
  }
  return ORIGINAL_GET_SITE_STATUS(item);
};

enrichProspects = async function enrichProspectsFast(items, geo, formData) {
  setProgress(52, "Recherche des sites déclarés dans OpenStreetMap…");

  try {
    const query = buildOverpassQuery(geo, formData.radiusKm, SEGMENTS[formData.category]);
    const overpass = await fetchOverpass(query);
    applyOsmMatches(items, mapOsmElements(overpass));
  } catch {
    showNotice(
      "OpenStreetMap n’a pas répondu en moins de 8 secondes. La recherche continue sans bloquer l’application.",
      "warning"
    );
  }

  const unresolved = items
    .filter((item) => !item.website)
    .sort((left, right) => right.businessScore - left.businessScore);

  const toCheck = unresolved.slice(0, FAST_ENRICHMENT.domainProspectLimit);
  const deferred = unresolved.slice(FAST_ENRICHMENT.domainProspectLimit);
  for (const item of deferred) {
    item.websiteDiscoveryStatus = "deferred";
    updatePriority(item);
  }

  if (toCheck.length) {
    let completed = 0;
    setProgress(64, `Vérification DNS des domaines plausibles (0/${toCheck.length})…`);

    await mapWithConcurrency(toCheck, FAST_ENRICHMENT.concurrency, async (item) => {
      await discoverDomainForItem(item);
      updatePriority(item);
      completed += 1;
      setProgress(
        64 + Math.round((completed / toCheck.length) * 14),
        `Vérification DNS des domaines plausibles (${completed}/${toCheck.length})…`
      );
    });
  }

  for (const item of items) {
    if (!item.website && item.websiteDiscoveryStatus === "pending") {
      item.websiteDiscoveryStatus = "not_found";
    }
    updatePriority(item);
  }

  const auditable = items
    .filter((item) => item.website)
    .sort((left, right) => right.businessScore - left.businessScore)
    .slice(0, FAST_ENRICHMENT.auditLimit);

  if (auditable.length) {
    let completed = 0;
    await mapWithConcurrency(auditable, FAST_ENRICHMENT.concurrency, async (item) => {
      await auditWebsite(item);
      completed += 1;
      setProgress(
        80 + Math.round((completed / auditable.length) * 17),
        `Analyse des sites retrouvés (${completed}/${auditable.length})…`
      );
    });
  }
};
