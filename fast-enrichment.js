"use strict";

const FAST_ENRICHMENT = Object.freeze({
  lookupLimit: 6,
  auditLimit: 3,
  requestDelayMs: 1100,
  websiteTimeoutMs: 5000,
  auditConcurrency: 2
});

const ORIGINAL_CONTAINS_EXCLUDED_BRAND = containsExcludedBrand;
const ORIGINAL_CALCULATE_SITE_NEED = calculateSiteNeed;
const ORIGINAL_GET_SITE_STATUS = getSiteStatus;

containsExcludedBrand = function containsExcludedBrandPatched(...values) {
  if (ORIGINAL_CONTAINS_EXCLUDED_BRAND(...values)) return true;
  const normalized = normalizeWords(values.filter(Boolean).join(" "));
  return [
    "bchef",
    "black and white burger",
    "chamas tacos",
    "nabab kebab",
    "otacos",
    "o tacos",
    "pokawa",
    "sushi shop",
    "brioche doree",
    "refectory"
  ].some((brand) => normalized.includes(normalizeWords(brand)));
};

calculateSiteNeed = function calculateVerifiedSiteNeed(prospect) {
  if (prospect.noSiteConfirmed || prospect.audit) {
    return ORIGINAL_CALCULATE_SITE_NEED(prospect);
  }
  return null;
};

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getNominatimName(result) {
  return sanitizeText(firstDefined(
    result?.namedetails?.name,
    result?.namedetails?.brand,
    result?.namedetails?.operator,
    result?.name,
    String(result?.display_name || "").split(",")[0]
  ), 220);
}

function getNominatimWebsite(result) {
  const tags = result?.extratags || {};
  return normalizeUrl(firstDefined(
    tags["contact:website"],
    tags.website,
    tags.url,
    tags["contact:url"]
  ));
}

function getNominatimPhone(result) {
  const tags = result?.extratags || {};
  return sanitizeText(firstDefined(
    tags["contact:phone"],
    tags.phone,
    tags["contact:mobile"],
    tags.mobile
  ), 60) || null;
}

function getNominatimSocial(result) {
  const tags = result?.extratags || {};
  return [
    tags["contact:facebook"],
    tags.facebook,
    tags["contact:instagram"],
    tags.instagram
  ].filter(Boolean).map((value) => sanitizeText(value, 240)).slice(0, 4);
}

function scoreNominatimResult(item, result) {
  const resultName = getNominatimName(result);
  const nameScore = tokenSimilarity(item.commercialName || item.name, resultName);
  const latitude = Number(result?.lat);
  const longitude = Number(result?.lon);
  const distance = distanceKm(item.latitude, item.longitude, latitude, longitude);
  const displayName = normalizeWords(result?.display_name || "");
  const city = normalizeWords(item.city);
  const cityScore = city && displayName.includes(city) ? 1 : 0;
  const distanceScore = distance === null
    ? 0
    : distance <= 0.5
      ? 1
      : distance <= 2
        ? 0.75
        : distance <= 5
          ? 0.35
          : 0;

  return {
    result,
    resultName,
    distance,
    score: nameScore * 0.72 + cityScore * 0.16 + distanceScore * 0.12
  };
}

async function lookupBusinessInNominatim(item) {
  const query = [
    item.commercialName || item.name,
    item.city,
    "France"
  ].filter(Boolean).join(", ");

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "3",
    countrycodes: "fr",
    addressdetails: "1",
    extratags: "1",
    namedetails: "1",
    dedupe: "1"
  });

  const payload = await fetchJson(`${CONFIG.nominatimEndpoint}?${params}`, 9000);
  const candidates = Array.isArray(payload)
    ? payload.map((result) => scoreNominatimResult(item, result)).sort((left, right) => right.score - left.score)
    : [];
  const best = candidates[0];

  if (!best || best.score < 0.5 || (best.distance !== null && best.distance > 6)) {
    item.websiteDiscoveryStatus = "not_found";
    item.osmMatch = null;
    return;
  }

  item.osmMatch = {
    name: best.resultName,
    confidence: Number(best.score.toFixed(2)),
    distanceKm: best.distance === null ? null : Number(best.distance.toFixed(2))
  };
  item.phone = getNominatimPhone(best.result) || item.phone;
  item.social = getNominatimSocial(best.result);
  item.openingHours = sanitizeText(best.result?.extratags?.opening_hours, 300) || item.openingHours;

  const website = getNominatimWebsite(best.result);
  if (website) {
    item.website = website;
    item.websiteSource = "OpenStreetMap / Nominatim";
    item.websiteConfidence = best.score;
    item.websiteDiscoveryStatus = "found";
    item.noSiteConfirmed = false;
  } else {
    item.websiteDiscoveryStatus = "place_without_website";
  }
}

fetchWebsiteContent = async function fetchWebsiteContentPatched(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error("URL invalide.");

  const allOriginsUrl = `${CONFIG.allOriginsEndpoint}?${new URLSearchParams({ url: normalized })}`;
  try {
    const response = await fetchWithTimeout(
      allOriginsUrl,
      { headers: { Accept: "text/html,text/plain;q=0.9" } },
      FAST_ENRICHMENT.websiteTimeoutMs
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
    // Continue with the text reader fallback.
  }

  const readerUrl = `${CONFIG.jinaEndpoint}${normalized.replace(/^https?:\/\//i, "")}`;
  const response = await fetchWithTimeout(
    readerUrl,
    { headers: { Accept: "text/plain" } },
    FAST_ENRICHMENT.websiteTimeoutMs
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

getSiteStatus = function getVerifiedSiteStatus(item) {
  if (item.noSiteConfirmed) return { label: "Aucun site confirmé", className: "bad" };
  if (item.audit) return { label: "Site trouvé et analysé", className: "good" };
  if (item.website && item.auditStatus === "failed") return { label: "Site trouvé, analyse impossible", className: "neutral" };
  if (item.website) return { label: "Site trouvé automatiquement", className: "neutral" };
  if (item.websiteDiscoveryStatus === "place_without_website") {
    return { label: "Établissement trouvé, site non renseigné", className: "pending" };
  }
  if (item.websiteDiscoveryStatus === "not_found") {
    return { label: "Site non identifié", className: "pending" };
  }
  if (item.websiteDiscoveryStatus === "deferred") {
    return { label: "À enrichir", className: "pending" };
  }
  return ORIGINAL_GET_SITE_STATUS(item);
};

enrichProspects = async function enrichProspectsWithNominatim(items) {
  const ordered = [...items].sort((left, right) => right.businessScore - left.businessScore);
  const toLookup = ordered.slice(0, FAST_ENRICHMENT.lookupLimit);
  const deferred = ordered.slice(FAST_ENRICHMENT.lookupLimit);

  for (const item of deferred) {
    item.websiteDiscoveryStatus = "deferred";
    updatePriority(item);
  }

  for (let index = 0; index < toLookup.length; index += 1) {
    const item = toLookup[index];
    item.websiteDiscoveryStatus = "searching";
    render();
    setProgress(
      56 + Math.round((index / Math.max(1, toLookup.length)) * 20),
      `Identification ciblée des sites (${index + 1}/${toLookup.length})…`
    );

    try {
      await lookupBusinessInNominatim(item);
    } catch {
      item.websiteDiscoveryStatus = "not_found";
    }

    updatePriority(item);
    persistItems();
    render();

    if (index < toLookup.length - 1) {
      await wait(FAST_ENRICHMENT.requestDelayMs);
    }
  }

  const auditable = ordered
    .filter((item) => item.website)
    .slice(0, FAST_ENRICHMENT.auditLimit);

  if (auditable.length) {
    let completed = 0;
    await mapWithConcurrency(auditable, FAST_ENRICHMENT.auditConcurrency, async (item) => {
      await auditWebsite(item);
      updatePriority(item);
      completed += 1;
      setProgress(
        80 + Math.round((completed / auditable.length) * 17),
        `Analyse des sites identifiés (${completed}/${auditable.length})…`
      );
      persistItems();
      render();
    });
  }

  for (const item of items) updatePriority(item);
};

for (const item of state.items) updatePriority(item);
persistItems();
render();
