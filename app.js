"use strict";

const CONFIG = Object.freeze({
  maxResults: 50,
  maxSourceResults: 100,
  maxRadiusKm: 50,
  requestTimeoutMs: 20000,
  storageKey: "signalLead.v4.items",
  storageVersion: 4,
  nominatimEndpoint: "https://nominatim.openstreetmap.org/search",
  companyEndpoint: "https://recherche-entreprises.api.gouv.fr/near_point"
});

const SEGMENTS = Object.freeze({
  fastfood: Object.freeze({
    label: "Restauration rapide",
    activityCodes: Object.freeze(["56.10C"]),
    commercialReason: "la commande en ligne, la visibilité locale et la conversion mobile sont déterminantes"
  }),
  restaurants: Object.freeze({
    label: "Restaurants",
    activityCodes: Object.freeze(["56.10A", "56.10B"]),
    commercialReason: "la réservation, les menus, les avis et la visibilité locale influencent directement le chiffre d’affaires"
  }),
  food: Object.freeze({
    label: "Restauration",
    activityCodes: Object.freeze(["56.10A", "56.10B", "56.10C"]),
    commercialReason: "la présence locale, la réservation et la commande en ligne sont des leviers commerciaux importants"
  }),
  building: Object.freeze({
    label: "Bâtiment",
    sectionCode: "F",
    commercialReason: "la confiance, les réalisations, les avis et les demandes de devis sont décisifs"
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
  count: document.querySelector("#result-count"),
  filter: document.querySelector("#filter"),
  budgetFilter: document.querySelector("#budget-filter"),
  websiteFilter: document.querySelector("#website-filter"),
  sort: document.querySelector("#sort"),
  notice: document.querySelector("#notice"),
  exportButton: document.querySelector("#export-button"),
  newSearch: document.querySelector("#new-search"),
  previewDialog: document.querySelector("#site-preview-dialog"),
  previewFrame: document.querySelector("#site-preview-frame"),
  previewUrl: document.querySelector("#preview-url"),
  closePreview: document.querySelector("#close-preview")
});

const state = {
  items: loadStoredItems(),
  noticeTimer: null,
  isLoading: false
};

function sanitizePlainText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function loadStoredItems() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CONFIG.storageVersion || !Array.isArray(parsed.items)) return [];
    return parsed.items.filter(isStoredProspectValid).slice(0, CONFIG.maxResults);
  } catch {
    return [];
  }
}

function isStoredProspectValid(item) {
  return Boolean(
    item &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    Number.isFinite(item.score) &&
    item.score >= 0 &&
    item.score <= 100
  );
}

function persistItems() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify({
      version: CONFIG.storageVersion,
      savedAt: new Date().toISOString(),
      items: state.items.slice(0, CONFIG.maxResults)
    }));
  } catch {
    showNotice("Le navigateur n’a pas pu sauvegarder les résultats localement.", "warning");
  }
}

function showNotice(message, kind = "info") {
  window.clearTimeout(state.noticeTimer);
  dom.notice.textContent = sanitizePlainText(message, 400);
  dom.notice.dataset.kind = kind;
  dom.notice.hidden = false;
  state.noticeTimer = window.setTimeout(() => {
    dom.notice.hidden = true;
  }, 7000);
}

function setProgress(percent, message) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  dom.progress.style.width = `${safePercent}%`;
  dom.progressText.textContent = message;
}

function setLoading(isLoading) {
  state.isLoading = isLoading;
  dom.launch.disabled = isLoading;
  dom.launch.textContent = isLoading ? "Recherche en cours…" : "Trouver et classer les entreprises";
}

function normalizeExternalUrl(value) {
  if (!value) return null;
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (isBlockedHostname(url.hostname)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function isBlockedHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^(0|10|127)\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  return false;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "strict-origin-when-cross-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Service distant indisponible (${response.status}).`);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) throw new Error("Réponse distante inattendue.");
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Le service distant a dépassé le délai autorisé.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function geocodeLocation(location) {
  const query = sanitizePlainText(location, 120);
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
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Coordonnées invalides.");
  return {
    latitude,
    longitude,
    label: sanitizePlainText(result.display_name, 200)
  };
}

function buildCompanySearchUrl({ geo, radiusKm, segment, page }) {
  const params = new URLSearchParams({
    lat: geo.latitude.toFixed(6),
    long: geo.longitude.toFixed(6),
    radius: String(Math.max(1, Math.min(CONFIG.maxRadiusKm, radiusKm))),
    page: String(page),
    per_page: "25",
    etat_administratif: "A",
    include: "siege,complements,finances,matching_etablissements"
  });
  if (segment.sectionCode) {
    params.set("section_activite_principale", segment.sectionCode);
  } else {
    params.set("activite_principale", segment.activityCodes.join(","));
  }
  return `${CONFIG.companyEndpoint}?${params}`;
}

function getCompanyResults(data) {
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.resultats)) return data.resultats;
  return [];
}

async function fetchCompanies(formData, geo) {
  const segment = SEGMENTS[formData.category];
  const requestedPages = formData.limit <= 25 ? 2 : 4;
  const pageNumbers = Array.from({ length: requestedPages }, (_, index) => index + 1);
  const responses = await Promise.all(pageNumbers.map((page) => fetchJson(buildCompanySearchUrl({
    geo,
    radiusKm: formData.radiusKm,
    segment,
    page
  }))));
  return responses.flatMap(getCompanyResults).slice(0, CONFIG.maxSourceResults);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeLegalCode(value) {
  return sanitizePlainText(value, 8).replace(/\D/g, "");
}

function isExcludedOrganization(company) {
  const complements = company?.complements || {};
  const legalCode = normalizeLegalCode(firstDefined(company?.nature_juridique, company?.nature_juridique_unite_legale));
  const legalLabel = sanitizePlainText(firstDefined(company?.libelle_nature_juridique, company?.nature_juridique_libelle), 180).toLowerCase();
  const name = sanitizePlainText(firstDefined(company?.nom_complet, company?.nom_raison_sociale, company?.sigle), 200).toLowerCase();
  const isAssociation = complements.est_association === true || ASSOCIATION_LEGAL_CODES.has(legalCode) || legalLabel.includes("association");
  const isPublic = PUBLIC_LEGAL_CODE_PREFIXES.some((prefix) => legalCode.startsWith(prefix)) || /commune|département|région|établissement public|administration/.test(legalLabel);
  const obviousAssociationName = /(^|\s)(association|amicale|club|comité|fédération)(\s|$)/.test(name);
  return isAssociation || isPublic || obviousAssociationName;
}

function getHeadOffice(company) {
  return company?.siege || company?.matching_etablissements?.[0] || company?.etablissement_siege || {};
}

function getFinancialRecord(company) {
  const finances = company?.finances;
  if (!finances || typeof finances !== "object") return null;
  const values = Object.entries(finances)
    .map(([year, record]) => ({ year: Number(year), record }))
    .filter((entry) => Number.isFinite(entry.year) && entry.record && typeof entry.record === "object")
    .toSorted((a, b) => b.year - a.year);
  return values[0] || null;
}

function parseMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function employeeMidpoint(code) {
  const value = sanitizePlainText(code, 10).toUpperCase();
  const map = {
    "00": 0,
    "NN": 0,
    "01": 1,
    "02": 4,
    "03": 8,
    "11": 15,
    "12": 35,
    "21": 75,
    "22": 150,
    "31": 225,
    "32": 375,
    "41": 750,
    "42": 1500,
    "51": 3500,
    "52": 7500,
    "53": 10000
  };
  return map[value] ?? null;
}

function formatAddress(site) {
  const direct = firstDefined(site?.adresse, site?.adresse_complete);
  if (direct) return sanitizePlainText(direct, 240);
  const parts = [
    [site?.numero_voie, site?.type_voie, site?.libelle_voie].filter(Boolean).join(" "),
    site?.code_postal,
    firstDefined(site?.libelle_commune, site?.commune, site?.ville)
  ].filter(Boolean);
  return sanitizePlainText(parts.join(", "), 240) || "Adresse non renseignée";
}

function yearsSince(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, (Date.now() - date.getTime()) / 31_556_952_000);
}

function estimateBudget({ revenue, employees, employer, establishmentsOpen, category }) {
  let points = 0;
  const evidence = [];

  if (revenue !== null) {
    if (revenue >= 2_000_000) { points += 5; evidence.push("CA public supérieur à 2 M€"); }
    else if (revenue >= 500_000) { points += 4; evidence.push("CA public supérieur à 500 k€"); }
    else if (revenue >= 150_000) { points += 3; evidence.push("CA public supérieur à 150 k€"); }
    else { points += 1; evidence.push("CA public disponible mais limité"); }
  }

  if (employees !== null) {
    if (employees >= 10) { points += 4; evidence.push("Équipe d’au moins 10 salariés estimés"); }
    else if (employees >= 3) { points += 3; evidence.push("Équipe de plusieurs salariés estimée"); }
    else if (employees >= 1) { points += 2; evidence.push("Présence salariale estimée"); }
  }

  if (employer === true) { points += 2; evidence.push("Entreprise employeuse"); }
  if (establishmentsOpen >= 2) { points += 3; evidence.push(`${establishmentsOpen} établissements ouverts`); }
  if (["PME", "ETI", "GE"].includes(category)) { points += 2; evidence.push(`Catégorie ${category}`); }

  const level = points >= 9 ? "high" : points >= 5 ? "medium" : "low";
  const label = level === "high" ? "Fort" : level === "medium" ? "Moyen" : "Faible ou inconnu";
  return { level, label, points, evidence: evidence.slice(0, 4) };
}

function calculateCommercialPriority({ budget, ageYears, establishmentsOpen, employees, employer, hasCommercialName, segment }) {
  let score = 24;
  const reasons = [];
  const strengths = [];

  if (budget.level === "high") { score += 30; reasons.push("Capacité d’investissement estimée forte"); }
  else if (budget.level === "medium") { score += 19; reasons.push("Capacité d’investissement estimée moyenne"); }
  else { score += 5; reasons.push("Budget non confirmé par les données publiques"); }

  if (ageYears !== null) {
    if (ageYears >= 2 && ageYears <= 15) { score += 13; reasons.push("Entreprise établie mais encore en phase de développement"); }
    else if (ageYears < 2) { score += 8; reasons.push("Entreprise récemment créée"); }
    else { score += 5; strengths.push("Entreprise ancienne et installée"); }
  }

  if (establishmentsOpen >= 2) { score += 10; reasons.push("Plusieurs établissements à valoriser"); }
  if (employees !== null && employees >= 3) { score += 8; reasons.push("Organisation structurée avec salariés"); }
  if (employer === true) { score += 5; strengths.push("Statut employeur confirmé"); }
  if (hasCommercialName) { score += 4; strengths.push("Enseigne commerciale identifiée"); }
  if (segment === "fastfood" || segment === "restaurants") { score += 5; reasons.push("Activité très dépendante de la visibilité locale"); }

  return {
    score: Math.max(1, Math.min(99, Math.round(score))),
    reasons: reasons.slice(0, 5),
    strengths: strengths.slice(0, 3)
  };
}

function createMessage(prospect, service, segment) {
  const segmentInfo = SEGMENTS[segment];
  const evidence = prospect.reasons.slice(0, 2).join(" et ").toLowerCase();
  return [
    "Bonjour,",
    "",
    `Je me permets de vous contacter au sujet de ${prospect.name}. Votre activité fait partie des secteurs où ${segmentInfo.commercialReason}.`,
    "",
    evidence ? `Les informations publiques indiquent notamment ${evidence}.` : "Votre entreprise présente un profil intéressant pour renforcer sa présence numérique.",
    "",
    `Je propose ${sanitizePlainText(service, 160).toLowerCase()} avec un diagnostic préalable des priorités réellement utiles à votre activité.`,
    "",
    "Seriez-vous disponible pour un échange de 15 minutes ?",
    "",
    "Bien cordialement,"
  ].join("\n");
}

function mapCompanyToProspect(company, service, segment) {
  if (!company || isExcludedOrganization(company)) return null;

  const site = getHeadOffice(company);
  const complements = company.complements || {};
  const financialEntry = getFinancialRecord(company);
  const financial = financialEntry?.record || {};
  const revenue = parseMoney(firstDefined(financial.ca, financial.chiffre_affaires, financial.chiffre_affaires_net));
  const result = parseMoney(firstDefined(financial.resultat_net, financial.resultat));
  const employeeCode = firstDefined(company.tranche_effectif_salarie, site.tranche_effectif_salarie);
  const employees = employeeMidpoint(employeeCode);
  const employer = firstDefined(company.caractere_employeur, site.caractere_employeur) === "O" || firstDefined(company.est_employeur, complements.est_employeur) === true;
  const establishmentsOpen = Number(firstDefined(company.nombre_etablissements_ouverts, company.nombre_etablissements, 1)) || 1;
  const category = sanitizePlainText(firstDefined(company.categorie_entreprise, complements.categorie_entreprise), 20).toUpperCase() || "Inconnue";
  const creationDate = sanitizePlainText(firstDefined(company.date_creation, company.date_creation_unite_legale, site.date_creation), 20) || null;
  const ageYears = creationDate ? yearsSince(creationDate) : null;
  const commercialName = sanitizePlainText(firstDefined(site.enseigne, site.nom_commercial, company.nom_commercial), 180) || null;
  const budget = estimateBudget({ revenue, employees, employer, establishmentsOpen, category });
  const priority = calculateCommercialPriority({
    budget,
    ageYears,
    establishmentsOpen,
    employees,
    employer,
    hasCommercialName: Boolean(commercialName),
    segment
  });

  const name = sanitizePlainText(firstDefined(company.nom_complet, company.nom_raison_sociale, commercialName, company.sigle), 200);
  if (!name) return null;

  const prospect = {
    id: sanitizePlainText(firstDefined(company.siren, site.siret, crypto.randomUUID()), 40),
    name,
    commercialName,
    activityLabel: sanitizePlainText(firstDefined(company.libelle_activite_principale, site.libelle_activite_principale, SEGMENTS[segment].label), 180),
    activityCode: sanitizePlainText(firstDefined(company.activite_principale, site.activite_principale), 12),
    address: formatAddress(site),
    city: sanitizePlainText(firstDefined(site.libelle_commune, site.commune), 120),
    siren: sanitizePlainText(company.siren, 12),
    siret: sanitizePlainText(site.siret, 18),
    legalForm: sanitizePlainText(firstDefined(company.libelle_nature_juridique, company.nature_juridique), 180),
    creationDate,
    ageYears,
    establishmentsOpen,
    employeeCode: sanitizePlainText(employeeCode, 10),
    employees,
    employer,
    companyCategory: category,
    revenue,
    result,
    financialYear: financialEntry?.year || null,
    budget,
    score: priority.score,
    reasons: priority.reasons,
    strengths: priority.strengths,
    website: null,
    technology: "Non analysée",
    websiteNotes: "",
    status: "new",
    source: "Annuaire des Entreprises / INSEE",
    capturedAt: new Date().toISOString(),
    segment
  };
  prospect.message = createMessage(prospect, service, segment);
  return prospect;
}

function deduplicateProspects(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.siren || item.siret || `${item.name.toLowerCase()}|${item.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function discoverProspects(formData) {
  setProgress(8, "Localisation de la zone…");
  const geo = await geocodeLocation(formData.location);
  setProgress(26, "Recherche dans le registre officiel des entreprises…");
  const companies = await fetchCompanies(formData, geo);
  setProgress(68, "Exclusion des associations et calcul du potentiel d’achat…");
  const prospects = deduplicateProspects(
    companies.map((company) => mapCompanyToProspect(company, formData.service, formData.category)).filter(Boolean)
  );
  prospects.sort((a, b) => b.score - a.score || b.budget.points - a.budget.points || a.name.localeCompare(b.name, "fr"));
  return { geo, prospects: prospects.slice(0, formData.limit) };
}

function readFormData() {
  const service = sanitizePlainText(dom.service.value, 160);
  const location = sanitizePlainText(dom.location.value, 120);
  const category = Object.hasOwn(SEGMENTS, dom.category.value) ? dom.category.value : "fastfood";
  const radiusKm = Math.max(1, Math.min(CONFIG.maxRadiusKm, Number(dom.radius.value) || 20));
  const limit = Math.max(10, Math.min(CONFIG.maxResults, Number(dom.resultLimit.value) || CONFIG.maxResults));
  if (service.length < 3) throw new Error("Décris plus précisément le service vendu.");
  if (location.length < 2) throw new Error("Indique une ville ou une zone valide.");
  return { service, location, category, radiusKm, limit };
}

function createElement(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = String(options.text);
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) element.setAttribute(name, String(value));
  }
  return element;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) return "Non publié";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value) {
  if (!value) return "Non renseignée";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR").format(date);
}

function createMetric(label, value, emphasis = false) {
  const box = createElement("div", { className: `metric${emphasis ? " metric-emphasis" : ""}` });
  box.append(createElement("span", { text: label }), createElement("strong", { text: value }));
  return box;
}

function getGoogleSearchUrl(prospect) {
  const query = [prospect.commercialName || prospect.name, prospect.city || prospect.address, "site officiel"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function openPreview(prospect) {
  if (!prospect.website) {
    showNotice("Enregistre d’abord une URL vérifiée pour afficher l’aperçu.", "warning");
    return;
  }
  dom.previewUrl.textContent = prospect.website;
  dom.previewFrame.src = prospect.website;
  dom.previewDialog.showModal();
}

function createProspectCard(prospect) {
  const article = createElement("article", { className: "result-card" });
  const summary = createElement("div");
  summary.append(createElement("h3", { text: prospect.commercialName || prospect.name }));
  if (prospect.commercialName && prospect.commercialName !== prospect.name) {
    summary.append(createElement("div", { className: "legal-name", text: prospect.name }));
  }
  summary.append(createElement("div", {
    className: "result-subtitle",
    text: `${prospect.activityLabel || "Activité non renseignée"} · ${prospect.address}`
  }));

  const signals = createElement("div", { className: "signal-list" });
  signals.append(createElement("span", { className: `signal-tag budget-${prospect.budget.level}`, text: `Budget ${prospect.budget.label}` }));
  for (const reason of prospect.reasons) signals.append(createElement("span", { className: "signal-tag warning", text: reason }));
  for (const strength of prospect.strengths) signals.append(createElement("span", { className: "signal-tag positive", text: strength }));
  summary.append(signals);

  const scoreBlock = createElement("div", { className: "score-block" });
  const scoreClass = prospect.score < 50 ? "low" : prospect.score < 75 ? "medium" : "";
  scoreBlock.append(
    createElement("span", { className: `opportunity-score${scoreClass ? ` ${scoreClass}` : ""}`, text: `${prospect.score}/100` }),
    createElement("small", { text: "priorité commerciale" })
  );

  const details = createElement("details", { className: "result-details" });
  details.append(createElement("summary", { text: "Voir le potentiel, le site et préparer le contact" }));

  const metrics = createElement("div", { className: "metrics-grid" });
  metrics.append(
    createMetric("Budget estimé", prospect.budget.label, prospect.budget.level === "high"),
    createMetric("Chiffre d’affaires", prospect.revenue !== null ? `${formatMoney(prospect.revenue)}${prospect.financialYear ? ` (${prospect.financialYear})` : ""}` : "Non publié"),
    createMetric("Effectif estimé", prospect.employees !== null ? String(prospect.employees) : "Non publié"),
    createMetric("Établissements ouverts", String(prospect.establishmentsOpen)),
    createMetric("Création", formatDate(prospect.creationDate)),
    createMetric("Catégorie", prospect.companyCategory || "Inconnue")
  );
  details.append(metrics);

  const detailGrid = createElement("div", { className: "detail-grid" });
  const companyColumn = createElement("div");
  companyColumn.append(createElement("h4", { text: "Qualification de l’entreprise" }));
  const facts = createElement("dl", { className: "facts-list" });
  const factEntries = [
    ["SIREN", prospect.siren || "Non renseigné"],
    ["SIRET local", prospect.siret || "Non renseigné"],
    ["Code APE", prospect.activityCode || "Non renseigné"],
    ["Forme juridique", prospect.legalForm || "Non renseignée"],
    ["Employeur", prospect.employer ? "Oui" : "Non confirmé"],
    ["Résultat net", prospect.result !== null ? formatMoney(prospect.result) : "Non publié"]
  ];
  for (const [label, value] of factEntries) {
    facts.append(createElement("dt", { text: label }), createElement("dd", { text: value }));
  }
  companyColumn.append(facts);

  const websiteColumn = createElement("div");
  websiteColumn.append(createElement("h4", { text: "Site et technologie" }));
  const websiteLabel = createElement("label", { text: "URL du site vérifié", attributes: { for: `website-${prospect.id}` } });
  const websiteInput = createElement("input", {
    className: "website-input",
    attributes: {
      id: `website-${prospect.id}`,
      type: "url",
      inputmode: "url",
      placeholder: "https://www.exemple.fr",
      maxlength: "2048"
    }
  });
  websiteInput.value = prospect.website || "";
  const websiteFeedback = createElement("p", {
    className: "website-feedback",
    text: prospect.website ? `Site enregistré · Technologie : ${prospect.technology}` : "Aucun site vérifié. La technologie reste non analysée."
  });
  const saveWebsite = createElement("button", { className: "secondary-button", text: "Enregistrer l’URL" });
  saveWebsite.type = "button";
  saveWebsite.addEventListener("click", () => {
    const normalized = normalizeExternalUrl(websiteInput.value.trim());
    if (!normalized) {
      showNotice("URL invalide ou adresse locale interdite.", "error");
      return;
    }
    prospect.website = normalized;
    prospect.technology = "Non analysée";
    websiteInput.value = normalized;
    websiteFeedback.textContent = "Site enregistré · Technologie : non analysée";
    persistItems();
    render();
    showNotice("URL vérifiée enregistrée pour ce prospect.", "success");
  });
  websiteColumn.append(websiteLabel, websiteInput, websiteFeedback, saveWebsite);

  detailGrid.append(companyColumn, websiteColumn);
  details.append(detailGrid);

  const messageSection = createElement("div", { className: "message-section" });
  messageSection.append(createElement("h4", { text: "Message proposé" }));
  const textarea = createElement("textarea", {
    className: "message-box",
    attributes: { "aria-label": `Message pour ${prospect.name}` }
  });
  textarea.value = prospect.message;
  textarea.addEventListener("input", () => {
    prospect.message = textarea.value.slice(0, 4000);
    persistItems();
  });
  messageSection.append(textarea);
  details.append(messageSection);

  const actions = createElement("div", { className: "card-actions" });
  const searchSite = createElement("a", {
    className: "secondary-button",
    text: "Rechercher le site",
    attributes: { href: getGoogleSearchUrl(prospect), target: "_blank", rel: "noopener noreferrer" }
  });
  actions.append(searchSite);

  if (prospect.website) {
    const previewButton = createElement("button", { className: "secondary-button", text: "Aperçu du site" });
    previewButton.type = "button";
    previewButton.addEventListener("click", () => openPreview(prospect));
    actions.append(previewButton);
    actions.append(createElement("a", {
      className: "secondary-button",
      text: "Ouvrir le site",
      attributes: { href: prospect.website, target: "_blank", rel: "noopener noreferrer nofollow" }
    }));
  }

  const copyButton = createElement("button", { className: "secondary-button", text: "Copier le message" });
  copyButton.type = "button";
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(prospect.message);
      showNotice("Message copié.", "success");
    } catch {
      textarea.select();
      showNotice("Sélectionne puis copie le message manuellement.", "warning");
    }
  });
  actions.append(copyButton);

  const statusSelect = createElement("select", {
    className: "status-select",
    attributes: { "aria-label": `Statut de ${prospect.name}` }
  });
  for (const [value, label] of Object.entries(STATUS_LABELS)) {
    const option = createElement("option", { text: label, attributes: { value } });
    option.selected = prospect.status === value;
    statusSelect.append(option);
  }
  statusSelect.addEventListener("change", () => {
    prospect.status = Object.hasOwn(STATUS_LABELS, statusSelect.value) ? statusSelect.value : "new";
    persistItems();
  });
  actions.append(statusSelect);
  details.append(actions);

  article.append(summary, scoreBlock, details);
  return article;
}

function getVisibleItems() {
  const query = sanitizePlainText(dom.filter.value, 120).toLowerCase();
  const budgetFilter = dom.budgetFilter.value;
  const websiteFilter = dom.websiteFilter.value;
  const items = state.items.filter((item) => {
    const matchesText = !query || [item.name, item.commercialName, item.activityLabel, item.activityCode, item.address, item.city, item.siren, item.siret]
      .filter(Boolean).join(" ").toLowerCase().includes(query);
    const matchesBudget = budgetFilter === "all" || item.budget.level === "high" || (budgetFilter === "medium" && item.budget.level === "medium");
    const matchesWebsite = websiteFilter === "all" || (websiteFilter === "known" ? Boolean(item.website) : !item.website);
    return matchesText && matchesBudget && matchesWebsite;
  });

  return items.toSorted((a, b) => {
    switch (dom.sort.value) {
      case "budget": return b.budget.points - a.budget.points || b.score - a.score;
      case "revenue": return (b.revenue ?? -1) - (a.revenue ?? -1) || b.score - a.score;
      case "employees": return (b.employees ?? -1) - (a.employees ?? -1) || b.score - a.score;
      case "recent": return String(b.creationDate || "").localeCompare(String(a.creationDate || ""));
      case "name": return a.name.localeCompare(b.name, "fr");
      default: return b.score - a.score || b.budget.points - a.budget.points;
    }
  });
}

function render() {
  const items = getVisibleItems();
  dom.count.textContent = `${items.length} prospect${items.length > 1 ? "s" : ""}`;
  dom.results.replaceChildren();
  if (!items.length) {
    const empty = createElement("div", { className: "empty-state" });
    empty.append(createElement("strong", { text: "Aucun prospect à afficher." }));
    empty.append(createElement("p", { text: "Lance une recherche ou élargis les filtres." }));
    dom.results.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of items) fragment.append(createProspectCard(item));
  dom.results.append(fragment);
}

function quoteCsv(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  if (!state.items.length) {
    showNotice("Aucun prospect à exporter.", "warning");
    return;
  }
  const rows = [[
    "Entreprise", "Enseigne", "Activité", "APE", "Adresse", "SIREN", "SIRET", "Création", "Effectif estimé",
    "Établissements", "CA public", "Année CA", "Budget estimé", "Score", "Site vérifié", "Technologie", "Statut", "Source"
  ], ...state.items.map((item) => [
    item.name, item.commercialName || "", item.activityLabel, item.activityCode, item.address, item.siren, item.siret,
    item.creationDate || "", item.employees ?? "", item.establishmentsOpen, item.revenue ?? "", item.financialYear ?? "",
    item.budget.label, item.score, item.website || "", item.technology, STATUS_LABELS[item.status] || STATUS_LABELS.new, item.source
  ])];
  const csv = rows.map((row) => row.map(quoteCsv).join(";")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `signallead-prospects-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.isLoading) return;
  try {
    const formData = readFormData();
    setLoading(true);
    setProgress(2, "Préparation de la recherche…");
    const result = await discoverProspects(formData);
    state.items = result.prospects;
    persistItems();
    render();
    setProgress(100, `${state.items.length} entreprises privées classées autour de ${result.geo.label}.`);
    showNotice(`${state.items.length} entreprises classées. Associations et structures publiques exclues.`, "success");
  } catch (error) {
    setProgress(0, "La recherche n’a pas abouti.");
    showNotice(error instanceof Error ? error.message : "Une erreur inattendue est survenue.", "error");
  } finally {
    setLoading(false);
  }
}

dom.form.addEventListener("submit", handleSubmit);
dom.filter.addEventListener("input", render);
dom.budgetFilter.addEventListener("change", render);
dom.websiteFilter.addEventListener("change", render);
dom.sort.addEventListener("change", render);
dom.exportButton.addEventListener("click", exportCsv);
dom.newSearch.addEventListener("click", () => {
  dom.service.focus();
  dom.form.scrollIntoView({ behavior: "smooth", block: "start" });
});
dom.closePreview.addEventListener("click", () => dom.previewDialog.close());
dom.previewDialog.addEventListener("close", () => {
  dom.previewFrame.src = "about:blank";
  dom.previewUrl.textContent = "";
});

render();
