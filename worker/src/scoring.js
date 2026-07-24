const LEGAL_WORDS = new Set([
  "sarl", "sas", "sasu", "eurl", "sa", "ei", "societe", "entreprise",
  "etablissement", "etablissements", "groupe", "holding", "france"
]);

const GENERIC_WORDS = new Set([
  "restaurant", "restauration", "rapide", "sushi", "pizza", "burger",
  "burgers", "kebab", "tacos", "food", "foods", "service", "services",
  "gestion", "company", "compagnie", "chez", "le", "la", "les", "de",
  "du", "des", "and", "et", "officiel", "accueil"
]);

const DIRECTORY_HOSTS = new Set([
  "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "youtube.com",
  "pagesjaunes.fr", "tripadvisor.fr", "tripadvisor.com", "thefork.fr",
  "ubereats.com", "deliveroo.fr", "just-eat.fr", "google.com", "google.fr",
  "societe.com", "pappers.fr", "verif.com", "annuaire-entreprises.data.gouv.fr"
]);

const PARKING_MARKERS = [
  "domain for sale",
  "buy this domain",
  "this domain is for sale",
  "ce nom de domaine est a vendre",
  "nom de domaine a vendre",
  "parkingcrew",
  "sedoparking",
  "hugedomains",
  "dan.com"
];

export function sanitizeText(value, maxLength = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function normalizeText(value) {
  return sanitizeText(value, 20_000)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "").replace(/^33/, "0");
}

export function distinctiveTokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((word) => word.length >= 3 && !LEGAL_WORDS.has(word) && !GENERIC_WORDS.has(word));
}

export function tokenSimilarity(left, right) {
  const leftTokens = new Set(distinctiveTokens(left));
  const rightTokens = new Set(distinctiveTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;

  let common = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) common += 1;
  }
  return common / Math.max(leftTokens.size, rightTokens.size);
}

export function isDirectoryHost(hostname) {
  const normalized = String(hostname ?? "").toLowerCase().replace(/^www\./, "");
  return [...DIRECTORY_HOSTS].some(
    (blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`)
  );
}

function getDomainText(urlValue) {
  try {
    const hostname = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
    return normalizeText(hostname.replace(/\.(fr|com|net|org|eu|io)$/i, ""));
  } catch {
    return "";
  }
}

function addressEvidence(business, content) {
  const address = normalizeText(business.address);
  if (!address) return false;

  const tokens = address
    .split(" ")
    .filter((token) => token.length >= 3 || /^\d{2,5}$/.test(token))
    .slice(0, 8);
  if (!tokens.length) return false;

  const matches = tokens.filter((token) => content.includes(token)).length;
  return matches >= Math.min(2, tokens.length);
}

export function scoreWebsiteIdentity({ business, url, title, description, text }) {
  const displayName = business.commercialName || business.name || "";
  const expected = normalizeText(displayName);
  const city = normalizeText(business.city);
  const content = normalizeText(`${title || ""} ${description || ""} ${text || ""}`);
  const titleText = normalizeText(title);
  const domainText = getDomainText(url);
  const nameTokens = distinctiveTokens(displayName);

  if (!content || PARKING_MARKERS.some((marker) => content.includes(marker))) {
    return { accepted: false, score: 0, evidence: ["Page vide ou domaine stationné"] };
  }

  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { accepted: false, score: 0, evidence: ["URL invalide"] };
  }

  if (isDirectoryHost(hostname)) {
    return { accepted: false, score: 0, evidence: ["Annuaire ou réseau social exclu"] };
  }

  const matchedTokens = nameTokens.filter((token) => content.includes(token));
  const tokenRatio = nameTokens.length ? matchedTokens.length / nameTokens.length : 0;
  const titleNameMatch = expected.length >= 4 && titleText.includes(expected);
  const bodyNameMatch = expected.length >= 4 && content.includes(expected);
  const domainMatches = nameTokens.filter((token) => domainText.includes(token)).length;
  const domainRatio = nameTokens.length ? domainMatches / nameTokens.length : 0;
  const cityMatch = city.length >= 3 && content.includes(city);
  const addressMatch = addressEvidence(business, content);
  const expectedPhone = normalizePhone(business.phone);
  const pagePhone = normalizePhone(text);
  const phoneMatch = expectedPhone.length >= 10 && pagePhone.includes(expectedPhone.slice(-9));
  const shortIdentity = nameTokens.length <= 1;

  let score = 0;
  if (titleNameMatch) score += 0.38;
  else if (bodyNameMatch) score += 0.14;
  score += tokenRatio * 0.24;
  score += domainRatio * 0.16;
  if (cityMatch) score += 0.1;
  if (addressMatch) score += 0.06;
  if (phoneMatch) score += 0.06;

  score = Math.min(1, score);

  const independentLocationProof = cityMatch || addressMatch || phoneMatch;
  const strongNameProof = titleNameMatch
    || (!shortIdentity && (bodyNameMatch || tokenRatio >= 0.67));
  const independentDomainProof = !shortIdentity && domainRatio >= 0.5;
  const supportingProof = independentLocationProof || independentDomainProof;
  const accepted = score >= 0.62 && strongNameProof && supportingProof;

  const evidence = [];
  if (titleNameMatch) evidence.push("Nom de l’entreprise présent dans le titre");
  else if (!shortIdentity && (bodyNameMatch || tokenRatio >= 0.67)) {
    evidence.push("Nom commercial fortement concordant");
  }
  if (domainRatio >= 0.5) evidence.push("Nom de domaine cohérent");
  if (cityMatch) evidence.push("Ville retrouvée sur le site");
  if (addressMatch) evidence.push("Adresse concordante");
  if (phoneMatch) evidence.push("Téléphone concordant");

  return {
    accepted,
    score: Number(score.toFixed(2)),
    evidence,
    diagnostics: {
      titleNameMatch,
      bodyNameMatch,
      shortIdentity,
      tokenRatio: Number(tokenRatio.toFixed(2)),
      domainRatio: Number(domainRatio.toFixed(2)),
      cityMatch,
      addressMatch,
      phoneMatch
    }
  };
}

export function scorePlaceMatch({ business, place, distanceKm }) {
  const expectedName = business.commercialName || business.name;
  const nameScore = tokenSimilarity(expectedName, place.name);
  const cityScore = business.city && place.address
    ? tokenSimilarity(business.city, place.address)
    : 0;
  const distanceScore = distanceKm === null
    ? 0
    : distanceKm <= 0.35
      ? 1
      : distanceKm <= 1.5
        ? 0.8
        : distanceKm <= 4
          ? 0.4
          : 0;
  const websiteBonus = place.website ? 0.05 : 0;
  const score = Math.min(1, nameScore * 0.66 + distanceScore * 0.23 + cityScore * 0.06 + websiteBonus);

  return {
    accepted: score >= 0.56 && (distanceKm === null || distanceKm <= 6),
    score: Number(score.toFixed(2)),
    evidence: [
      nameScore >= 0.6 ? "Nom concordant" : null,
      distanceKm !== null && distanceKm <= 1.5 ? "Établissement proche de l’adresse" : null,
      cityScore >= 0.5 ? "Ville concordante" : null,
      place.website ? "Site déclaré dans OpenStreetMap" : null
    ].filter(Boolean)
  };
}
