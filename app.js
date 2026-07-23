"use strict";

const CONFIG = Object.freeze({
  maxResults: 50,
  maxRadiusKm: 50,
  requestTimeoutMs: 18000,
  storageKey: "signalLead.v6.items",
  storageVersion: 6,
  nominatimEndpoint: "https://nominatim.openstreetmap.org/search",
  companyEndpoint: "https://recherche-entreprises.api.gouv.fr/near_point",
  overpassEndpoints: Object.freeze([
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter"
  ]),
  allOriginsEndpoint: "https://api.allorigins.win/raw",
  jinaEndpoint: "https://r.jina.ai/http://",
  screenshotEndpoint: "https://image.thum.io/get/width/1200/crop/760/noanimate/",
  automaticDomainChecks: 15,
  automaticAudits: 12,
  maximumEmployees: 50,
  maximumEstablishments: 10,
  maximumRevenue: 20_000_000
});

const SEGMENTS = Object.freeze({
  fastfood: Object.freeze({
    label: "Restauration rapide",
    activityCodes: Object.freeze(["56.10C"]),
    need: "la commande en ligne, la visibilité locale et la conversion mobile",
    osmSelectors: Object.freeze([
      '["amenity"="fast_food"]',
      '["cuisine"="kebab"]',
      '["cuisine"="burger"]',
      '["cuisine"="pizza"]'
    ])
  }),
  restaurants: Object.freeze({
    label: "Restaurant",
    activityCodes: Object.freeze(["56.10A", "56.10B"]),
    need: "les réservations, les menus, les avis et la visibilité locale",
    osmSelectors: Object.freeze([
      '["amenity"="restaurant"]',
      '["amenity"="cafe"]'
    ])
  }),
  food: Object.freeze({
    label: "Restauration",
    activityCodes: Object.freeze(["56.10A", "56.10B", "56.10C"]),
    need: "la réservation, la commande et la visibilité locale",
    osmSelectors: Object.freeze([
      '["amenity"="restaurant"]',
      '["amenity"="fast_food"]',
      '["amenity"="cafe"]'
    ])
  }),
  building: Object.freeze({
    label: "Bâtiment",
    sectionCode: "F",
    need: "les réalisations, les avis et les demandes de devis",
    osmSelectors: Object.freeze([
      '["craft"="plumber"]',
      '["craft"="electrician"]',
      '["craft"="carpenter"]',
      '["craft"="roofer"]',
      '["craft"="painter"]',
      '["craft"="bricklayer"]',
      '["craft"="builder"]',
      '["office"="construction_company"]'
    ])
  })
});

const STATUS_LABELS = Object.freeze({
  new: "Nouveau",
  contacted: "Contacté",
  replied: "Répondu",
  won: "Gagné",
  ignored: "Ignoré"
});

const ASSOCIATION_LEGAL_CODES = new Set(["9210", "9220", "9221", "9222", "9230", "9240", "9260"]);
const PUBLIC_LEGAL_CODE_PREFIXES = Object.freeze(["71", "72", "73", "74"]);
const MANUAL_WEIGHTS = Object.freeze({
  datedDesign: 14,
  poorMobile: 16,
  weakConversion: 18,
  weakTrust: 10,
  confusingNavigation: 10,
  siteGood: -45
});

const EXCLUDED_BRANDS = Object.freeze([
  "burger king", "quick", "mcdonald", "kfc", "subway", "domino s", "pizza hut",
  "five guys", "starbucks", "otacos", "o tacos", "pitaya", "pokawa", "big fernand",
  "sushi shop", "brioche doree", "la mie caline", "marie blachere", "ange boulangerie",
  "columbus cafe", "bagelstein", "class croute", "flunch", "buffalo grill", "courtepaille",
  "del arte", "hippopotamus", "speed burger", "paul", "re factory", "refectory",
  "vinci", "eiffage", "bouygues construction", "spie", "equans", "engie solutions"
]);

const dom = Object.freeze({
  form: document.querySelector("#search-form"),
  service: document.querySelector("#service"),
  category: document.querySelector("#category"),
  location: document.querySelector("#location"),
  radius: document.querySelector("#radius"),
  resultLimit: document.querySelector("#result-limit"),
  launch: document.querySelector("#launch"),
  progress: document.querySelector("#progress"),
  progressText: document.querySelector("#progress-text"),
  results: document.querySelector("#results"),
  emptyState: document.querySelector("#empty-state"),
  count: document.querySelector("#result-count"),
  filter: document.querySelector("#filter"),
  qualificationFilter: document.querySelector("#qualification-filter"),
  sort: document.querySelector("#sort"),
  notice: document.querySelector("#notice"),
  exportButton: document.querySelector("#export-button"),
  newSearch: document.querySelector("#new-search"),
  summaryTotal: document.querySelector("#summary-total"),
  summaryAudited: document.querySelector("#summary-audited"),
  summaryHigh: document.querySelector("#summary-high"),
  summaryPending: document.querySelector("#summary-pending"),
  dialog: document.querySelector("#prospect-dialog"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogSubtitle: document.querySelector("#dialog-subtitle"),
  dialogSegment: document.querySelector("#dialog-segment"),
  closeDialog: document.querySelector("#close-dialog"),
  dialogBusinessScore: document.querySelector("#dialog-business-score"),
  dialogSiteScore: document.querySelector("#dialog-site-score"),
  dialogMetrics: document.querySelector("#dialog-metrics"),
  dialogBusinessEvidence: document.querySelector("#dialog-business-evidence"),
  siteUrl: document.querySelector("#site-url"),
  findSite: document.querySelector("#find-site"),
  saveSite: document.querySelector("#save-site"),
  auditSite: document.querySelector("#audit-site"),
  noSiteConfirmed: document.querySelector("#no-site-confirmed"),
  websitePreview: document.querySelector("#website-preview"),
  auditMetrics: document.querySelector("#audit-metrics"),
  technologyList: document.querySelector("#technology-list"),
  manualReview: document.querySelector(".manual-review"),
  prospectStatus: document.querySelector("#prospect-status"),
  contactMessage: document.querySelector("#contact-message"),
  copyMessage: document.querySelector("#copy-message"),
  openSite: document.querySelector("#open-site"),
  saveProspect: document.querySelector("#save-prospect")
});

const state = {
  items: loadItems(),
  selectedId: null,
  isLoading: false,
  noticeTimer: null
};

function sanitizeText(value, max = 220) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function normalizeWords(value) {
  return sanitizeText(value, 300)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(sarl|sas|sasu|eurl|sa|ei|societe|entreprise|etablissement|france|groupe|holding)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeWords(value)
    .split(" ")
    .filter((token) => token.length > 1)
    .slice(0, 5)
    .join("-")
    .slice(0, 55);
}

function tokenSimilarity(left, right) {
  const a = new Set(normalizeWords(left).split(" ").filter((token) => token.length > 1));
  const b = new Set(normalizeWords(right).split(" ").filter((token) => token.length > 1));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function loadItems() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "null");
    if (!parsed || parsed.version !== CONFIG.storageVersion || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isValidItem).slice(0, CONFIG.maxResults);
  } catch {
    return [];
  }
}

function isValidItem(item) {
  return Boolean(
    item &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    Number.isFinite(item.businessScore)
  );
}

function persistItems() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify({
      version: CONFIG.storageVersion,
      savedAt: new Date().toISOString(),
      items: state.items
    }));
  } catch {
    showNotice("Impossible d’enregistrer les résultats dans ce navigateur.", "warning");
  }
}

function showNotice(message, kind = "info") {
  clearTimeout(state.noticeTimer);
  dom.notice.textContent = sanitizeText(message, 500);
  dom.notice.dataset.kind = kind;
  dom.notice.hidden = false;
  state.noticeTimer = setTimeout(() => {
    dom.notice.hidden = true;
  }, 8000);
}

function setProgress(percent, message) {
  dom.progress.style.width = `${clamp(percent)}%`;
  dom.progressText.textContent = message;
}

function setLoading(value) {
  state.isLoading = value;
  dom.launch.disabled = value;
  dom.launch.textContent = value ? "Recherche et analyse en cours…" : "Lancer la recherche";
}

function isBlockedHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^(0|10|127)\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function normalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || isBlockedHostname(url.hostname)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "strict-origin-when-cross-origin",
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = CONFIG.requestTimeoutMs) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "application/json" }
    }, timeoutMs);
    if (!response.ok) throw new Error(`Service distant indisponible (${response.status}).`);
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Le service a dépassé le délai autorisé.");
    }
    throw error;
  }
}

async function fetchText(url, timeoutMs = CONFIG.requestTimeoutMs) {
  try {
    const response = await fetchWithTimeout(url, {
      headers: { Accept: "text/html,text/plain;q=0.9,*/*;q=0.8" }
    }, timeoutMs);
    if (!response.ok) throw new Error(`Service distant indisponible (${response.status}).`);
    return await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Le service a dépassé le délai autorisé.");
    }
    throw error;
  }
}

async function geocodeLocation(location) {
  const query = sanitizeText(location, 120);
  if (query.length < 2) throw new Error("La zone géographique est trop courte.");
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
    countrycodes: "fr"
  });
  const data = await fetchJson(`${CONFIG.nominatimEndpoint}?${params}`);
  const result = Array.isArray(data) ? data[0] : null;
  if (!result) throw new Error("Zone introuvable en France.");
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Coordonnées géographiques invalides.");
  }
  return {
    latitude,
    longitude,
    label: sanitizeText(result.display_name, 200)
  };
}

function buildCompanyUrl({ geo, radiusKm, segment, page }) {
  const params = new URLSearchParams({
    lat: geo.latitude.toFixed(6),
    long: geo.longitude.toFixed(6),
    radius: String(Math.min(CONFIG.maxRadiusKm, Math.max(1, radiusKm))),
    page: String(page),
    per_page: "25",
    etat_administratif: "A"
  });
  if (segment.sectionCode) params.set("section_activite_principale", segment.sectionCode);
  else params.set("activite_principale", segment.activityCodes.join(","));
  return `${CONFIG.companyEndpoint}?${params}`;
}

function getCompanyResults(data) {
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.resultats)) return data.resultats;
  return [];
}

async function fetchCompanies(formData, geo) {
  const segment = SEGMENTS[formData.category];
  const pages = formData.limit > 25 ? [1, 2, 3, 4] : [1, 2];
  const responses = await Promise.all(
    pages.map((page) => fetchJson(buildCompanyUrl({
      geo,
      radiusKm: formData.radiusKm,
      segment,
      page
    })))
  );
  return responses.flatMap(getCompanyResults).slice(0, 100);
}

function normalizeLegalCode(value) {
  return sanitizeText(value, 8).replace(/\D/g, "");
}

function isExcludedOrganization(company) {
  const complements = company?.complements || {};
  const legalCode = normalizeLegalCode(firstDefined(company?.nature_juridique, company?.nature_juridique_unite_legale));
  const legalLabel = sanitizeText(firstDefined(company?.libelle_nature_juridique, company?.nature_juridique_libelle), 180).toLowerCase();
  const name = normalizeWords(firstDefined(company?.nom_complet, company?.nom_raison_sociale, company?.sigle));
  const association = complements.est_association === true || ASSOCIATION_LEGAL_CODES.has(legalCode) || legalLabel.includes("association") || /(^|\s)(association|amicale|club|comite|federation)(\s|$)/.test(name);
  const publicBody = PUBLIC_LEGAL_CODE_PREFIXES.some((prefix) => legalCode.startsWith(prefix)) || /commune|departement|region|etablissement public|administration/.test(normalizeWords(legalLabel));
  return association || publicBody;
}

function getCoordinates(site) {
  const latitude = Number(firstDefined(site?.latitude, site?.lat, site?.coordonnees?.latitude));
  const longitude = Number(firstDefined(site?.longitude, site?.lon, site?.coordonnees?.longitude));
  return {
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null
  };
}

function distanceKm(aLatitude, aLongitude, bLatitude, bLongitude) {
  if (![aLatitude, aLongitude, bLatitude, bLongitude].every(Number.isFinite)) return null;
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadius = 6371;
  const latitudeDelta = toRadians(bLatitude - aLatitude);
  const longitudeDelta = toRadians(bLongitude - aLongitude);
  const first = Math.sin(latitudeDelta / 2) ** 2;
  const second = Math.cos(toRadians(aLatitude)) * Math.cos(toRadians(bLatitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(first + second), Math.sqrt(1 - first - second));
}

function getLocalEstablishment(company, geo) {
  const matches = Array.isArray(company?.matching_etablissements)
    ? company.matching_etablissements
    : [];
  if (matches.length) {
    return [...matches].sort((left, right) => {
      const leftCoordinates = getCoordinates(left);
      const rightCoordinates = getCoordinates(right);
      const leftDistance = distanceKm(geo.latitude, geo.longitude, leftCoordinates.latitude, leftCoordinates.longitude) ?? Number.POSITIVE_INFINITY;
      const rightDistance = distanceKm(geo.latitude, geo.longitude, rightCoordinates.latitude, rightCoordinates.longitude) ?? Number.POSITIVE_INFINITY;
      return leftDistance - rightDistance;
    })[0];
  }
  return company?.siege || company?.etablissement_siege || {};
}

function getFinancial(company) {
  const finances = company?.finances;
  if (!finances || typeof finances !== "object") return null;
  return Object.entries(finances)
    .map(([year, record]) => ({ year: Number(year), record }))
    .filter((entry) => Number.isFinite(entry.year) && entry.record && typeof entry.record === "object")
    .sort((left, right) => right.year - left.year)[0] || null;
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function employeeMidpoint(code) {
  const map = {
    "00": 0, "NN": 0, "01": 1, "02": 4, "03": 8, "11": 15, "12": 35,
    "21": 75, "22": 150, "31": 225, "32": 375, "41": 750, "42": 1500,
    "51": 3500, "52": 7500, "53": 10000
  };
  return map[sanitizeText(code, 10).toUpperCase()] ?? null;
}

function formatAddress(site) {
  const direct = firstDefined(site?.adresse, site?.adresse_complete);
  if (direct) return sanitizeText(direct, 260);
  const parts = [
    [site?.numero_voie, site?.type_voie, site?.libelle_voie].filter(Boolean).join(" "),
    site?.code_postal,
    firstDefined(site?.libelle_commune, site?.commune, site?.ville)
  ].filter(Boolean);
  return sanitizeText(parts.join(" "), 260) || "Adresse non renseignée";
}

function yearsSince(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Math.max(0, (Date.now() - date.getTime()) / 31556952000);
}

function containsExcludedBrand(...values) {
  const normalized = normalizeWords(values.filter(Boolean).join(" "));
  return EXCLUDED_BRANDS.some((brand) => normalized.includes(normalizeWords(brand)));
}

function calculateBusinessFit({ revenue, employees, employer, establishments, ageYears, companyCategory, hasTradeName, segment }) {
  let score = 24;
  const evidence = [];

  if (revenue !== null) {
    if (revenue >= 300_000 && revenue <= 8_000_000) {
      score += 22;
      evidence.push("Chiffre d’affaires compatible avec une prestation externe");
    } else if (revenue > 8_000_000 && revenue <= CONFIG.maximumRevenue) {
      score += 10;
      evidence.push("Capacité d’investissement élevée mais décision plus structurée");
    } else if (revenue > CONFIG.maximumRevenue) {
      score -= 30;
      evidence.push("Structure trop importante pour la cible commerciale");
    } else {
      score += 6;
      evidence.push("Chiffre d’affaires public limité");
    }
  } else {
    score += 7;
    evidence.push("Chiffre d’affaires non publié");
  }

  if (employees !== null) {
    if (employees >= 2 && employees <= 20) {
      score += 20;
      evidence.push("Taille idéale pour joindre directement un décideur");
    } else if (employees > 20 && employees <= CONFIG.maximumEmployees) {
      score += 10;
      evidence.push("PME structurée encore accessible commercialement");
    } else if (employees > CONFIG.maximumEmployees) {
      score -= 35;
      evidence.push("Effectif trop important pour la cible");
    } else {
      score += 5;
    }
  }

  if (employer) {
    score += 7;
    evidence.push("Statut employeur confirmé");
  }

  if (establishments >= 1 && establishments <= 5) {
    score += 10;
    evidence.push("Réseau local de taille accessible");
  } else if (establishments > CONFIG.maximumEstablishments) {
    score -= 30;
    evidence.push("Réseau trop important, probablement déjà accompagné");
  } else if (establishments > 5) {
    score += 2;
  }

  if (ageYears !== null && ageYears >= 1 && ageYears <= 15) {
    score += 9;
    evidence.push("Entreprise installée et encore en développement");
  } else if (ageYears !== null && ageYears < 1) {
    score += 3;
    evidence.push("Entreprise très récente");
  }

  if (hasTradeName) score += 5;
  if (["ETI", "GE"].includes(companyCategory)) score -= 45;
  if (["fastfood", "restaurants", "food", "building"].includes(segment)) score += 6;

  return { score: clamp(score), evidence: evidence.slice(0, 6) };
}

function createMessage(prospect, service) {
  const siteEvidence = prospect.noSiteConfirmed
    ? "Je n’ai pas identifié de site officiel actif pour votre établissement."
    : prospect.siteNeed
      ? `L’analyse de votre présence en ligne fait ressortir ${prospect.siteNeed.evidence.slice(0, 2).join(" et ").toLowerCase()}.`
      : "Votre présence en ligne pourrait être vérifiée et améliorée sur des points concrets.";
  return [
    "Bonjour,",
    "",
    `Je me permets de vous contacter au sujet de ${prospect.commercialName || prospect.name}.`,
    "",
    `${siteEvidence} Dans votre secteur, ${SEGMENTS[prospect.segment].need} ont un impact direct sur les demandes clients.`,
    "",
    `Je propose ${sanitizeText(service, 160).toLowerCase()} et peux vous transmettre un diagnostic court, fondé sur des éléments vérifiables.`,
    "",
    "Seriez-vous disponible pour un échange de 15 minutes ?",
    "",
    "Bien cordialement,"
  ].join("\n");
}

function mapCompany(company, formData, geo) {
  if (!company || isExcludedOrganization(company)) return null;

  const localSite = getLocalEstablishment(company, geo);
  const localCoordinates = getCoordinates(localSite);
  const localDistance = distanceKm(geo.latitude, geo.longitude, localCoordinates.latitude, localCoordinates.longitude);
  if (localDistance !== null && localDistance > formData.radiusKm * 1.15) return null;

  const financialEntry = getFinancial(company);
  const financial = financialEntry?.record || {};
  const revenue = parseMoney(firstDefined(financial.ca, financial.chiffre_affaires, financial.chiffre_affaires_net));
  const netResult = parseMoney(firstDefined(financial.resultat_net, financial.resultat));
  const employeeCode = firstDefined(company.tranche_effectif_salarie, localSite.tranche_effectif_salarie);
  const employees = employeeMidpoint(employeeCode);
  const employer = firstDefined(company.caractere_employeur, localSite.caractere_employeur) === "O" || firstDefined(company.est_employeur, company?.complements?.est_employeur) === true;
  const establishments = Number(firstDefined(company.nombre_etablissements_ouverts, company.nombre_etablissements, 1)) || 1;
  const companyCategory = sanitizeText(firstDefined(company.categorie_entreprise, company?.complements?.categorie_entreprise), 20).toUpperCase() || "Inconnue";
  const creationDate = sanitizeText(firstDefined(company.date_creation, company.date_creation_unite_legale, localSite.date_creation), 20) || null;
  const commercialName = sanitizeText(firstDefined(localSite.enseigne, localSite.nom_commercial, company.nom_commercial), 180) || null;
  const name = sanitizeText(firstDefined(company.nom_complet, company.nom_raison_sociale, commercialName, company.sigle), 200);
  if (!name) return null;

  if (containsExcludedBrand(name, commercialName)) return null;
  if (companyCategory === "GE" || companyCategory === "ETI") return null;
  if (employees !== null && employees > CONFIG.maximumEmployees) return null;
  if (establishments > CONFIG.maximumEstablishments) return null;
  if (revenue !== null && revenue > CONFIG.maximumRevenue) return null;

  const business = calculateBusinessFit({
    revenue,
    employees,
    employer,
    establishments,
    ageYears: creationDate ? yearsSince(creationDate) : null,
    companyCategory,
    hasTradeName: Boolean(commercialName),
    segment: formData.category
  });

  const prospect = {
    id: sanitizeText(firstDefined(company.siren, localSite.siret, crypto.randomUUID()), 40),
    name,
    commercialName,
    activityLabel: sanitizeText(firstDefined(company.libelle_activite_principale, localSite.libelle_activite_principale, SEGMENTS[formData.category].label), 180),
    activityCode: sanitizeText(firstDefined(company.activite_principale, localSite.activite_principale), 12),
    address: formatAddress(localSite),
    city: sanitizeText(firstDefined(localSite.libelle_commune, localSite.commune, localSite.ville), 120),
    latitude: localCoordinates.latitude,
    longitude: localCoordinates.longitude,
    distanceKm: localDistance,
    siren: sanitizeText(company.siren, 12),
    siret: sanitizeText(localSite.siret, 18),
    legalForm: sanitizeText(firstDefined(company.libelle_nature_juridique, company.nature_juridique), 180),
    creationDate,
    establishments,
    employees,
    employer,
    companyCategory,
    revenue,
    netResult,
    financialYear: financialEntry?.year || null,
    businessScore: business.score,
    businessEvidence: business.evidence,
    website: null,
    websiteSource: null,
    websiteConfidence: null,
    websiteDiscoveryStatus: "pending",
    phone: null,
    social: [],
    openingHours: null,
    noSiteConfirmed: false,
    audit: null,
    manualIssues: [],
    siteNeed: null,
    finalPriority: null,
    priorityConfidence: null,
    status: "new",
    segment: formData.category,
    service: formData.service,
    capturedAt: new Date().toISOString()
  };
  prospect.message = createMessage(prospect, formData.service);
  return prospect;
}

function deduplicate(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.siren || item.siret || `${item.name}|${item.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildOverpassQuery(geo, radiusKm, segment) {
  const radiusMeters = Math.round(Math.min(CONFIG.maxRadiusKm, Math.max(1, radiusKm)) * 1000);
  const around = `(around:${radiusMeters},${geo.latitude.toFixed(6)},${geo.longitude.toFixed(6)})`;
  const selectors = segment.osmSelectors.flatMap((selector) => [
    `node${selector}${around};`,
    `way${selector}${around};`,
    `relation${selector}${around};`
  ]);
  return `[out:json][timeout:25];(${selectors.join("")});out center tags 1800;`;
}

async function fetchOverpassByFetch(endpoint, query) {
  const params = new URLSearchParams({ data: query });
  return await fetchJson(`${endpoint}?${params}`, 30000);
}

async function fetchOverpassByJsonp(endpoint, query) {
  return await new Promise((resolve, reject) => {
    const callbackName = `__signalLeadOverpass${Date.now()}${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Le service OpenStreetMap a dépassé le délai autorisé."));
    }, 30000);

    function cleanup() {
      clearTimeout(timeout);
      script.remove();
      try {
        delete window[callbackName];
      } catch {
        window[callbackName] = undefined;
      }
    }

    window[callbackName] = (payload) => {
      cleanup();
      resolve(payload);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("Le service OpenStreetMap n’est pas disponible."));
    };

    const params = new URLSearchParams({ data: query, jsonp: callbackName });
    script.src = `${endpoint}?${params}`;
    document.head.append(script);
  });
}

async function fetchOverpass(query) {
  let lastError = null;
  for (const endpoint of CONFIG.overpassEndpoints) {
    try {
      return await fetchOverpassByFetch(endpoint, query);
    } catch (error) {
      lastError = error;
    }
  }
  for (const endpoint of CONFIG.overpassEndpoints) {
    try {
      return await fetchOverpassByJsonp(endpoint, query);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Aucun serveur OpenStreetMap n’est disponible.");
}

function getFirstTag(tags, keys) {
  for (const key of keys) {
    const value = tags?.[key];
    if (typeof value === "string" && value.trim()) return sanitizeText(value, 300);
  }
  return null;
}

function mapOsmElements(data) {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  return elements.map((element) => {
    const tags = element?.tags || {};
    const name = getFirstTag(tags, ["name", "brand", "operator"]);
    if (!name) return null;
    const latitude = Number(firstDefined(element.lat, element.center?.lat));
    const longitude = Number(firstDefined(element.lon, element.center?.lon));
    const website = normalizeUrl(getFirstTag(tags, ["contact:website", "website", "url"]));
    return {
      name,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      website,
      phone: getFirstTag(tags, ["contact:phone", "phone"]),
      openingHours: getFirstTag(tags, ["opening_hours"]),
      social: [
        getFirstTag(tags, ["contact:facebook", "facebook"]),
        getFirstTag(tags, ["contact:instagram", "instagram"])
      ].filter(Boolean),
      address: sanitizeText([
        [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
        tags["addr:postcode"],
        firstDefined(tags["addr:city"], tags["addr:town"], tags["addr:village"])
      ].filter(Boolean).join(" "), 260)
    };
  }).filter(Boolean);
}

function matchOsmRecord(prospect, records) {
  let best = null;
  const expectedName = prospect.commercialName || prospect.name;
  for (const record of records) {
    const nameScore = tokenSimilarity(expectedName, record.name);
    const distance = distanceKm(prospect.latitude, prospect.longitude, record.latitude, record.longitude);
    const cityScore = prospect.city && record.address
      ? tokenSimilarity(prospect.city, record.address)
      : 0;
    const distanceScore = distance === null ? 0 : distance <= 0.5 ? 1 : distance <= 2 ? 0.75 : distance <= 5 ? 0.35 : 0;
    const score = nameScore * 0.72 + distanceScore * 0.22 + cityScore * 0.06;
    if (!best || score > best.score) best = { record, score, distance };
  }
  if (!best) return null;
  if (best.score < 0.46) return null;
  if (best.distance !== null && best.distance > 6) return null;
  return best;
}

function applyOsmMatches(items, records) {
  for (const item of items) {
    const match = matchOsmRecord(item, records);
    if (!match) continue;
    item.osmMatch = {
      name: match.record.name,
      confidence: Number(match.score.toFixed(2)),
      distanceKm: match.distance === null ? null : Number(match.distance.toFixed(2))
    };
    item.phone = match.record.phone || item.phone;
    item.openingHours = match.record.openingHours || item.openingHours;
    item.social = match.record.social || item.social;
    if (match.record.website) {
      item.website = match.record.website;
      item.websiteSource = "OpenStreetMap";
      item.websiteConfidence = match.score;
      item.websiteDiscoveryStatus = "found";
    } else {
      item.websiteDiscoveryStatus = "osm_without_website";
    }
  }
}

function buildDomainCandidates(item) {
  const names = [item.commercialName, item.name]
    .filter(Boolean)
    .map(slugify)
    .filter((value) => value.length >= 4);
  const city = slugify(item.city);
  const baseNames = [...new Set(names)];
  const candidates = [];
  for (const name of baseNames) {
    candidates.push(`${name}.fr`, `${name}.com`);
    if (city) candidates.push(`${name}-${city}.fr`, `${city}-${name}.fr`);
  }
  return [...new Set(candidates)].slice(0, 6).map((host) => `https://${host}/`);
}

async function fetchWebsiteContent(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) throw new Error("URL invalide.");

  const allOriginsUrl = `${CONFIG.allOriginsEndpoint}?${new URLSearchParams({ url: normalized })}`;
  try {
    const html = await fetchText(allOriginsUrl, 16000);
    if (html && html.length > 80) return { content: html.slice(0, 2_000_000), format: "html", source: "AllOrigins" };
  } catch {
    // Continue with the text reader fallback.
  }

  const readerUrl = `${CONFIG.jinaEndpoint}${normalized.replace(/^https?:\/\//i, "")}`;
  const text = await fetchText(readerUrl, 16000);
  if (!text || text.length < 40) throw new Error("Contenu du site indisponible.");
  return { content: text.slice(0, 1_000_000), format: "text", source: "Jina Reader" };
}

function domainIdentityScore(item, candidateUrl, content) {
  const url = new URL(candidateUrl);
  const host = normalizeWords(url.hostname.replace(/^www\./, "").split(".")[0]);
  const expectedName = item.commercialName || item.name;
  const contentSample = sanitizeText(content, 120_000);
  let score = tokenSimilarity(expectedName, host) * 0.45;
  score += tokenSimilarity(expectedName, contentSample) * 0.4;
  if (item.city && normalizeWords(contentSample).includes(normalizeWords(item.city))) score += 0.1;
  if (item.siren && contentSample.includes(item.siren)) score += 0.25;
  return Math.min(1, score);
}

async function discoverDomainForItem(item) {
  for (const candidate of buildDomainCandidates(item)) {
    try {
      const document = await fetchWebsiteContent(candidate);
      const confidence = domainIdentityScore(item, candidate, document.content);
      if (confidence >= 0.52) {
        item.website = candidate;
        item.websiteSource = "Domaine détecté automatiquement";
        item.websiteConfidence = confidence;
        item.websiteDiscoveryStatus = "found";
        return;
      }
    } catch {
      // Try the next domain candidate.
    }
  }
  if (!item.website) item.websiteDiscoveryStatus = "not_found";
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function detectTechnologies(html) {
  const source = String(html || "");
  const lower = source.toLowerCase();
  const technologies = new Set();
  if (/wp-content|wp-includes|wordpress/.test(lower)) technologies.add("WordPress");
  if (/wixstatic|wix-code|wixsite/.test(lower)) technologies.add("Wix");
  if (/cdn\.shopify\.com|shopify-section|myshopify/.test(lower)) technologies.add("Shopify");
  if (/squarespace/.test(lower)) technologies.add("Squarespace");
  if (/webflow/.test(lower)) technologies.add("Webflow");
  if (/drupal-settings-json|sites\/default\/files/.test(lower)) technologies.add("Drupal");
  if (/joomla|\/media\/system\/js\//.test(lower)) technologies.add("Joomla");
  if (/__next_data__|\/_next\//.test(lower)) technologies.add("Next.js");
  if (/data-reactroot|react-dom|react\.production/.test(lower)) technologies.add("React");
  if (/data-v-|vue\.runtime|__vue__/.test(lower)) technologies.add("Vue.js");
  if (/ng-version|angular\.min\.js/.test(lower)) technologies.add("Angular");
  if (/bootstrap(?:\.min)?\.css|bootstrap(?:\.bundle)?(?:\.min)?\.js/.test(lower)) technologies.add("Bootstrap");
  if (/jquery(?:-|\.)(?:1\.|2\.)/.test(lower)) technologies.add("jQuery ancien");
  if (!technologies.size && /<!doctype html/i.test(source)) technologies.add("Site HTML / technologie non identifiée");
  return [...technologies].slice(0, 12);
}

function analyzeHtmlDocument(html, item) {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  const title = sanitizeText(document.querySelector("title")?.textContent, 240) || null;
  const description = sanitizeText(document.querySelector('meta[name="description"]')?.getAttribute("content"), 500) || null;
  const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || null;
  const language = document.documentElement.getAttribute("lang") || null;
  const h1Count = document.querySelectorAll("h1").length;
  const forms = document.querySelectorAll("form").length;
  const telephoneLinks = document.querySelectorAll('a[href^="tel:"]').length;
  const hasStructuredData = document.querySelectorAll('script[type="application/ld+json"]').length > 0;
  const text = normalizeWords(document.body?.textContent || "");
  const conversionWords = item.segment === "building"
    ? ["devis", "contact", "appel", "realisation", "projet"]
    : ["commander", "commande", "livraison", "reserver", "reservation", "menu", "contact"];
  const conversionHits = conversionWords.filter((word) => text.includes(word)).length;
  const technologies = detectTechnologies(html);

  let mobileScore = viewport ? 82 : 28;
  if (viewport && /width\s*=\s*device-width/i.test(viewport)) mobileScore += 10;

  let seoScore = 30;
  if (title && title.length >= 15 && title.length <= 70) seoScore += 28;
  else if (title) seoScore += 14;
  if (description && description.length >= 70) seoScore += 24;
  else if (description) seoScore += 10;
  if (h1Count === 1) seoScore += 12;
  if (hasStructuredData) seoScore += 8;

  let structureScore = 35;
  if (language) structureScore += 12;
  if (document.querySelector("main")) structureScore += 16;
  if (document.querySelector("nav")) structureScore += 10;
  if (document.querySelector("header")) structureScore += 7;
  if (document.querySelector("footer")) structureScore += 7;
  if (h1Count === 1) structureScore += 8;

  let conversionScore = 22;
  conversionScore += Math.min(36, conversionHits * 9);
  if (forms > 0) conversionScore += 18;
  if (telephoneLinks > 0) conversionScore += 16;
  if (document.querySelector('a[href*="maps"], a[href*="google.com/maps"]')) conversionScore += 8;

  const quality = clamp(
    clamp(mobileScore) * 0.25 +
    clamp(seoScore) * 0.28 +
    clamp(structureScore) * 0.2 +
    clamp(conversionScore) * 0.27
  );

  const evidence = [];
  if (!viewport) evidence.push("Affichage mobile non déclaré");
  if (!title) evidence.push("Titre de page absent");
  if (!description) evidence.push("Description SEO absente");
  if (h1Count !== 1) evidence.push("Structure du titre principal perfectible");
  if (!forms && !telephoneLinks) evidence.push("Prise de contact peu visible dans le HTML");
  if (conversionHits === 0) evidence.push("Aucun appel à l’action métier clairement détecté");
  if (technologies.includes("jQuery ancien")) evidence.push("Bibliothèque JavaScript ancienne détectée");
  if (quality >= 78) evidence.push("Fondations du site globalement satisfaisantes");

  return {
    auditedAt: new Date().toISOString(),
    source: "Analyse HTML gratuite",
    title,
    description,
    technologies,
    metrics: {
      mobile: clamp(mobileScore),
      seo: clamp(seoScore),
      structure: clamp(structureScore),
      conversion: clamp(conversionScore)
    },
    quality,
    evidence: evidence.slice(0, 8),
    screenshot: `${CONFIG.screenshotEndpoint}${encodeURI(item.website)}`
  };
}

function analyzeTextDocument(text, item) {
  const normalized = normalizeWords(text);
  const conversionWords = item.segment === "building"
    ? ["devis", "contact", "realisation", "projet"]
    : ["commander", "livraison", "reserver", "reservation", "menu", "contact"];
  const conversionHits = conversionWords.filter((word) => normalized.includes(word)).length;
  const conversion = clamp(25 + conversionHits * 14);
  const quality = clamp(42 + conversionHits * 8);
  return {
    auditedAt: new Date().toISOString(),
    source: "Analyse textuelle gratuite",
    title: null,
    description: null,
    technologies: [],
    metrics: { mobile: null, seo: null, structure: null, conversion },
    quality,
    evidence: conversionHits ? ["Des appels à l’action métier ont été détectés"] : ["Peu d’appels à l’action métier détectés"],
    screenshot: `${CONFIG.screenshotEndpoint}${encodeURI(item.website)}`
  };
}

async function auditWebsite(item) {
  if (!item.website) return;
  try {
    const result = await fetchWebsiteContent(item.website);
    item.audit = result.format === "html"
      ? analyzeHtmlDocument(result.content, item)
      : analyzeTextDocument(result.content, item);
    item.audit.fetchSource = result.source;
    updatePriority(item);
  } catch {
    item.auditStatus = "failed";
  }
}

function calculateSiteNeed(prospect) {
  if (prospect.noSiteConfirmed) {
    return {
      score: 94,
      label: "Aucun site confirmé",
      confidence: "Élevée",
      evidence: ["Absence de site confirmée après vérification"]
    };
  }

  if (prospect.audit) {
    let score = 100 - prospect.audit.quality;
    const evidence = [...(prospect.audit.evidence || [])];
    for (const issue of prospect.manualIssues || []) score += MANUAL_WEIGHTS[issue] || 0;
    if (prospect.manualIssues?.includes("siteGood")) evidence.push("Contrôle visuel : site déjà professionnel");
    const finalScore = clamp(score);
    return {
      score: finalScore,
      label: finalScore >= 70 ? "Refonte probable" : finalScore >= 45 ? "Améliorations utiles" : "Site plutôt satisfaisant",
      confidence: prospect.manualIssues?.length ? "Élevée" : "Moyenne",
      evidence: [...evidence, ...(prospect.audit.evidence || [])].filter(Boolean).slice(0, 8)
    };
  }

  if (prospect.websiteDiscoveryStatus === "not_found" || prospect.websiteDiscoveryStatus === "osm_without_website") {
    return {
      score: 68,
      label: "Site non retrouvé automatiquement",
      confidence: "Faible",
      evidence: ["Aucun site fiable retrouvé dans les sources gratuites et les domaines candidats"]
    };
  }

  return null;
}

function updatePriority(prospect) {
  prospect.siteNeed = calculateSiteNeed(prospect);
  if (!prospect.siteNeed) {
    prospect.finalPriority = null;
    prospect.priorityConfidence = null;
  } else {
    prospect.finalPriority = clamp(prospect.businessScore * 0.42 + prospect.siteNeed.score * 0.58);
    prospect.priorityConfidence = prospect.siteNeed.confidence;
  }
  prospect.message = createMessage(prospect, prospect.service || "création et refonte de sites web");
}

function readForm() {
  const service = sanitizeText(dom.service.value, 160);
  const location = sanitizeText(dom.location.value, 120);
  const category = Object.hasOwn(SEGMENTS, dom.category.value) ? dom.category.value : "fastfood";
  const radiusKm = Math.min(CONFIG.maxRadiusKm, Math.max(1, Number(dom.radius.value) || 20));
  const limit = Math.min(CONFIG.maxResults, Math.max(10, Number(dom.resultLimit.value) || 50));
  if (service.length < 3) throw new Error("Décris le service vendu.");
  if (location.length < 2) throw new Error("Indique une ville ou une zone.");
  return { service, location, category, radiusKm, limit };
}

async function enrichProspects(items, geo, formData) {
  setProgress(52, "Recherche gratuite des sites déclarés dans OpenStreetMap…");
  try {
    const query = buildOverpassQuery(geo, formData.radiusKm, SEGMENTS[formData.category]);
    const overpass = await fetchOverpass(query);
    applyOsmMatches(items, mapOsmElements(overpass));
  } catch {
    showNotice("OpenStreetMap n’a pas répondu. La recherche continue avec les domaines candidats.", "warning");
  }

  const missing = items
    .filter((item) => !item.website)
    .sort((left, right) => right.businessScore - left.businessScore)
    .slice(0, CONFIG.automaticDomainChecks);

  if (missing.length) {
    setProgress(66, `Vérification automatique de domaines gratuits (0/${missing.length})…`);
    let completed = 0;
    await mapWithConcurrency(missing, 3, async (item) => {
      await discoverDomainForItem(item);
      completed += 1;
      setProgress(66 + Math.round((completed / missing.length) * 12), `Vérification automatique de domaines (${completed}/${missing.length})…`);
    });
  }

  for (const item of items) {
    if (!item.website && item.websiteDiscoveryStatus === "pending") item.websiteDiscoveryStatus = "not_found";
    updatePriority(item);
  }

  const auditable = items
    .filter((item) => item.website)
    .sort((left, right) => right.businessScore - left.businessScore)
    .slice(0, CONFIG.automaticAudits);

  if (auditable.length) {
    let completed = 0;
    await mapWithConcurrency(auditable, 3, async (item) => {
      await auditWebsite(item);
      completed += 1;
      setProgress(80 + Math.round((completed / auditable.length) * 17), `Analyse gratuite des sites (${completed}/${auditable.length})…`);
    });
  }
}

async function searchProspects(event) {
  event.preventDefault();
  if (state.isLoading) return;

  try {
    const formData = readForm();
    setLoading(true);
    setProgress(5, "Localisation de la zone…");
    const geo = await geocodeLocation(formData.location);

    setProgress(18, "Recherche des entreprises actives…");
    const companies = await fetchCompanies(formData, geo);

    setProgress(38, "Exclusion des associations, chaînes et grandes structures…");
    const prospects = deduplicate(
      companies.map((company) => mapCompany(company, formData, geo)).filter(Boolean)
    )
      .sort((left, right) => right.businessScore - left.businessScore)
      .slice(0, formData.limit);

    state.items = prospects;
    render();

    if (prospects.length) await enrichProspects(prospects, geo, formData);

    persistItems();
    render();

    const foundSites = prospects.filter((item) => item.website).length;
    const auditedSites = prospects.filter((item) => item.audit).length;
    const highPriority = prospects.filter((item) => item.finalPriority >= 70).length;
    setProgress(100, `${prospects.length} entreprises ciblées, ${foundSites} sites trouvés, ${auditedSites} analysés.`);
    showNotice(`${highPriority} prospects prioritaires détectés sans service payant.`, "success");
  } catch (error) {
    setProgress(0, "La recherche n’a pas abouti.");
    showNotice(error instanceof Error ? error.message : "Erreur inattendue.", "error");
  } finally {
    setLoading(false);
  }
}

function formatMoney(value) {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value)
    : "Non publié";
}

function formatDate(value) {
  if (!value) return "Non renseignée";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("fr-FR").format(date);
}

function getSiteStatus(prospect) {
  if (prospect.noSiteConfirmed) return { label: "Aucun site confirmé", className: "bad" };
  if (prospect.audit) return { label: "Site trouvé et analysé", className: "good" };
  if (prospect.website) return { label: "Site trouvé automatiquement", className: "neutral" };
  if (prospect.websiteDiscoveryStatus === "osm_without_website") return { label: "Fiche trouvée sans site", className: "bad" };
  if (prospect.websiteDiscoveryStatus === "not_found") return { label: "Non retrouvé automatiquement", className: "pending" };
  return { label: "Recherche en cours", className: "pending" };
}

function getPriorityStatus(prospect) {
  if (prospect.finalPriority === null) return { label: "Non calculée", className: "pending" };
  const suffix = prospect.priorityConfidence === "Faible" ? " provisoire" : "";
  if (prospect.finalPriority >= 70) return { label: `${prospect.finalPriority}/100${suffix}`, className: "bad" };
  if (prospect.finalPriority >= 50) return { label: `${prospect.finalPriority}/100${suffix}`, className: "neutral" };
  return { label: `${prospect.finalPriority}/100`, className: "good" };
}

function getVisibleItems() {
  const query = sanitizeText(dom.filter.value, 120).toLowerCase();
  const qualification = dom.qualificationFilter.value;
  const sort = dom.sort.value;

  const items = state.items.filter((item) => {
    if (query && ![item.name, item.commercialName, item.city, item.address, item.activityLabel].join(" ").toLowerCase().includes(query)) return false;
    if (qualification === "high" && !(item.finalPriority >= 70)) return false;
    if (qualification === "audited" && !(item.audit || item.noSiteConfirmed)) return false;
    if (qualification === "pending" && (item.audit || item.noSiteConfirmed)) return false;
    return true;
  });

  return items.sort((left, right) => {
    if (sort === "business") return right.businessScore - left.businessScore;
    if (sort === "site") return (right.siteNeed?.score ?? -1) - (left.siteNeed?.score ?? -1);
    if (sort === "revenue") return (right.revenue ?? -1) - (left.revenue ?? -1);
    if (sort === "name") return (left.commercialName || left.name).localeCompare(right.commercialName || right.name, "fr");
    return (right.finalPriority ?? -1) - (left.finalPriority ?? -1) || right.businessScore - left.businessScore;
  });
}

function createCell(label) {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  return cell;
}

function createBadge(label, className) {
  const badge = document.createElement("span");
  badge.className = `status-badge ${className}`;
  badge.textContent = label;
  return badge;
}

function render() {
  const visible = getVisibleItems();
  dom.results.replaceChildren();
  dom.emptyState.hidden = visible.length > 0;
  dom.count.textContent = `${visible.length} entreprise${visible.length > 1 ? "s" : ""}`;

  const audited = state.items.filter((item) => item.audit || item.noSiteConfirmed).length;
  const high = state.items.filter((item) => item.finalPriority >= 70).length;
  const pending = state.items.filter((item) => !item.website && !item.noSiteConfirmed).length;
  dom.summaryTotal.textContent = String(state.items.length);
  dom.summaryAudited.textContent = String(audited);
  dom.summaryHigh.textContent = String(high);
  dom.summaryPending.textContent = String(pending);

  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const row = document.createElement("tr");

    const companyCell = createCell("Entreprise");
    companyCell.className = "company-cell";
    const name = document.createElement("strong");
    name.textContent = item.commercialName || item.name;
    const meta = document.createElement("span");
    meta.textContent = `${item.activityLabel || SEGMENTS[item.segment].label} · ${item.city || item.address}`;
    companyCell.append(name, meta);

    const businessCell = createCell("Potentiel");
    businessCell.append(
      Object.assign(document.createElement("span"), { className: "score-value", textContent: `${item.businessScore}/100` }),
      Object.assign(document.createElement("span"), { className: "score-caption", textContent: "adéquation commerciale" })
    );

    const siteCell = createCell("Site internet");
    const siteStatus = getSiteStatus(item);
    siteCell.append(createBadge(siteStatus.label, siteStatus.className));

    const needCell = createCell("Besoin web");
    needCell.append(item.siteNeed
      ? createBadge(`${item.siteNeed.score}/100 · ${item.siteNeed.label}`, item.siteNeed.score >= 60 ? "bad" : "good")
      : createBadge("Analyse indisponible", "pending"));

    const priorityCell = createCell("Priorité");
    const priority = getPriorityStatus(item);
    priorityCell.append(createBadge(priority.label, priority.className));

    const actionCell = createCell("Actions");
    actionCell.className = "row-actions";
    const button = document.createElement("button");
    button.className = "button button-secondary";
    button.type = "button";
    button.textContent = "Voir";
    button.addEventListener("click", () => openProspect(item.id));
    actionCell.append(button);

    row.append(companyCell, businessCell, siteCell, needCell, priorityCell, actionCell);
    fragment.append(row);
  }
  dom.results.append(fragment);
}

function createMetric(label, value) {
  const box = document.createElement("div");
  box.className = "metric";
  const span = document.createElement("span");
  span.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  box.append(span, strong);
  return box;
}

function selectedProspect() {
  return state.items.find((item) => item.id === state.selectedId) || null;
}

function openProspect(id) {
  state.selectedId = id;
  syncDialog();
  dom.dialog.showModal();
}

function syncDialog() {
  const item = selectedProspect();
  if (!item) return;

  dom.dialogTitle.textContent = item.commercialName || item.name;
  dom.dialogSubtitle.textContent = `${item.activityLabel} · ${item.address}`;
  dom.dialogSegment.textContent = SEGMENTS[item.segment]?.label || "Prospect";
  dom.dialogBusinessScore.textContent = `${item.businessScore}/100`;
  dom.dialogMetrics.replaceChildren(
    createMetric("SIREN", item.siren || "Non renseigné"),
    createMetric("Création", formatDate(item.creationDate)),
    createMetric("Effectif estimé", item.employees !== null ? String(item.employees) : "Non publié"),
    createMetric("Établissements", String(item.establishments)),
    createMetric("Chiffre d’affaires", formatMoney(item.revenue)),
    createMetric("Résultat net", formatMoney(item.netResult)),
    createMetric("Source du site", item.websiteSource || "Non retrouvé"),
    createMetric("Téléphone", item.phone || "Non renseigné")
  );

  dom.dialogBusinessEvidence.replaceChildren();
  for (const evidence of item.businessEvidence) {
    const chip = document.createElement("span");
    chip.className = "evidence-chip";
    chip.textContent = evidence;
    dom.dialogBusinessEvidence.append(chip);
  }

  dom.siteUrl.value = item.website || "";
  dom.noSiteConfirmed.checked = Boolean(item.noSiteConfirmed);
  dom.prospectStatus.value = item.status || "new";
  dom.contactMessage.value = item.message || "";
  dom.openSite.hidden = !item.website;
  if (item.website) dom.openSite.href = item.website;
  for (const input of dom.manualReview.querySelectorAll('input[type="checkbox"]')) {
    input.checked = item.manualIssues?.includes(input.value) || false;
  }
  renderAudit(item);
}

function renderAudit(item) {
  dom.dialogSiteScore.className = `score-pill${item.siteNeed ? "" : " neutral"}`;
  dom.dialogSiteScore.textContent = item.siteNeed ? `${item.siteNeed.score}/100` : "À vérifier";
  dom.websitePreview.replaceChildren();

  if (item.audit?.screenshot) {
    const image = document.createElement("img");
    image.src = item.audit.screenshot;
    image.alt = `Capture du site ${item.website || item.name}`;
    image.referrerPolicy = "no-referrer";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      image.replaceWith(createPreviewPlaceholder("La capture gratuite n’est pas disponible. Ouvre le site dans un nouvel onglet."));
    });
    dom.websitePreview.append(image);
  } else {
    dom.websitePreview.append(createPreviewPlaceholder(item.website
      ? "Le site a été trouvé, mais la capture n’est pas disponible."
      : "Aucun site fiable n’a été retrouvé automatiquement."));
  }

  dom.auditMetrics.replaceChildren();
  const metrics = [
    ["Mobile", item.audit?.metrics?.mobile],
    ["SEO de base", item.audit?.metrics?.seo],
    ["Structure", item.audit?.metrics?.structure],
    ["Conversion", item.audit?.metrics?.conversion]
  ];
  for (const [label, value] of metrics) {
    const box = document.createElement("div");
    box.className = "audit-metric";
    const span = document.createElement("span");
    span.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value === null || value === undefined ? "—" : `${value}/100`;
    box.append(span, strong);
    dom.auditMetrics.append(box);
  }

  dom.technologyList.replaceChildren();
  const technologies = item.audit?.technologies || [];
  if (!technologies.length) {
    const small = document.createElement("small");
    small.textContent = item.audit ? "Aucune technologie reconnue" : "Non analysées";
    dom.technologyList.append(small);
  } else {
    for (const technology of technologies) {
      const tag = document.createElement("span");
      tag.className = "tech-tag";
      tag.textContent = technology;
      dom.technologyList.append(tag);
    }
  }
}

function createPreviewPlaceholder(message) {
  const placeholder = document.createElement("div");
  placeholder.className = "preview-placeholder";
  const strong = document.createElement("strong");
  strong.textContent = "Aperçu indisponible";
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  placeholder.append(strong, paragraph);
  return placeholder;
}

function getSearchUrl(item) {
  return `https://duckduckgo.com/?q=${encodeURIComponent(`${item.commercialName || item.name} ${item.city || item.address} site officiel`)}`;
}

function saveCurrentDialog() {
  const item = selectedProspect();
  if (!item) return;
  const normalized = normalizeUrl(dom.siteUrl.value.trim());
  if (dom.siteUrl.value.trim() && !normalized) {
    showNotice("L’URL du site n’est pas valide ou pointe vers un réseau privé.", "warning");
    return;
  }

  item.website = normalized;
  item.noSiteConfirmed = dom.noSiteConfirmed.checked;
  if (item.noSiteConfirmed) {
    item.website = null;
    item.audit = null;
    item.websiteSource = "Absence confirmée manuellement";
  } else if (normalized && !item.websiteSource) {
    item.websiteSource = "Correction manuelle";
  }

  item.manualIssues = [...dom.manualReview.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
  item.status = Object.hasOwn(STATUS_LABELS, dom.prospectStatus.value)
    ? dom.prospectStatus.value
    : "new";
  item.message = dom.contactMessage.value.slice(0, 4000);
  updatePriority(item);
  persistItems();
  syncDialog();
  render();
  showNotice("Prospect mis à jour.", "success");
}

async function auditCurrentSite() {
  const item = selectedProspect();
  if (!item) return;
  const website = normalizeUrl(dom.siteUrl.value.trim() || item.website);
  if (!website) {
    showNotice("Aucun site valide à analyser.", "warning");
    return;
  }

  dom.auditSite.disabled = true;
  dom.auditSite.textContent = "Analyse en cours…";
  try {
    item.website = website;
    item.websiteSource = item.websiteSource || "Correction manuelle";
    item.noSiteConfirmed = false;
    await auditWebsite(item);
    if (!item.audit) throw new Error("Le contenu du site n’a pas pu être récupéré par les services gratuits.");
    persistItems();
    syncDialog();
    render();
    showNotice("Site analysé avec les sources gratuites disponibles.", "success");
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Analyse impossible.", "error");
  } finally {
    dom.auditSite.disabled = false;
    dom.auditSite.textContent = "Analyser le site";
  }
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!state.items.length) {
    showNotice("Aucun résultat à exporter.", "warning");
    return;
  }

  const rows = [
    ["Entreprise", "Enseigne", "Activité", "Ville", "SIREN", "Site", "Source du site", "Potentiel entreprise", "Besoin site", "Priorité", "Confiance", "Technologies", "CA", "Effectif", "Statut"],
    ...state.items.map((item) => [
      item.name,
      item.commercialName,
      item.activityLabel,
      item.city,
      item.siren,
      item.website,
      item.websiteSource,
      item.businessScore,
      item.siteNeed?.score ?? "",
      item.finalPriority ?? "",
      item.priorityConfidence ?? "",
      item.audit?.technologies?.join(" | ") || "",
      item.revenue ?? "",
      item.employees ?? "",
      STATUS_LABELS[item.status] || "Nouveau"
    ])
  ];

  const blob = new Blob([
    "\ufeff",
    rows.map((row) => row.map(csvValue).join(";")).join("\r\n")
  ], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `signallead-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function closeDialog() {
  dom.dialog.close();
  state.selectedId = null;
}

dom.form.addEventListener("submit", searchProspects);
dom.filter.addEventListener("input", render);
dom.qualificationFilter.addEventListener("change", render);
dom.sort.addEventListener("change", render);
dom.exportButton.addEventListener("click", exportCsv);
dom.newSearch.addEventListener("click", () => document.querySelector("#search").scrollIntoView({ behavior: "smooth" }));
dom.closeDialog.addEventListener("click", closeDialog);
dom.dialog.addEventListener("click", (event) => {
  if (event.target === dom.dialog) closeDialog();
});
dom.findSite.addEventListener("click", () => {
  const item = selectedProspect();
  if (item) window.open(getSearchUrl(item), "_blank", "noopener,noreferrer");
});
dom.saveSite.addEventListener("click", saveCurrentDialog);
dom.saveProspect.addEventListener("click", saveCurrentDialog);
dom.auditSite.addEventListener("click", auditCurrentSite);
dom.copyMessage.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(dom.contactMessage.value);
    showNotice("Message copié.", "success");
  } catch {
    dom.contactMessage.select();
    showNotice("Le texte est sélectionné : copie-le manuellement.", "warning");
  }
});
dom.noSiteConfirmed.addEventListener("change", () => {
  if (dom.noSiteConfirmed.checked) dom.siteUrl.value = "";
});
dom.manualReview.addEventListener("change", () => {
  const item = selectedProspect();
  if (!item) return;
  item.manualIssues = [...dom.manualReview.querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
  updatePriority(item);
  renderAudit(item);
});

render();
