"use strict";

const CONFIG = Object.freeze({
  maxResults: 50,
  maxRadiusKm: 50,
  requestTimeoutMs: 25000,
  storageKey: "signalLead.v3.items",
  storageVersion: 3,
  nominatimEndpoint: "https://nominatim.openstreetmap.org/search",
  companySearchEndpoint: "https://recherche-entreprises.api.gouv.fr/near_point",
  companyPageSize: 25,
  maxRemotePages: 2
});

const CATEGORY_SECTIONS = Object.freeze({
  artisans: Object.freeze(["C", "F", "S"]),
  restaurants: Object.freeze(["I"]),
  commerces: Object.freeze(["G"]),
  sante: Object.freeze(["Q"]),
  services: Object.freeze(["J", "L", "M", "N", "S"])
});

const ACTIVITY_LABELS = Object.freeze({
  A: "Agriculture, sylviculture et pêche",
  B: "Industries extractives",
  C: "Industrie manufacturière",
  D: "Énergie",
  E: "Eau, déchets et dépollution",
  F: "Construction",
  G: "Commerce et réparation",
  H: "Transport et entreposage",
  I: "Hébergement et restauration",
  J: "Information et communication",
  K: "Finance et assurance",
  L: "Immobilier",
  M: "Activités spécialisées et techniques",
  N: "Services administratifs et soutien",
  O: "Administration publique",
  P: "Enseignement",
  Q: "Santé et action sociale",
  R: "Arts, spectacles et loisirs",
  S: "Autres services"
});

const STATUS_LABELS = Object.freeze({
  new: "Nouveau",
  contacted: "Contacté",
  replied: "Répondu",
  won: "Gagné",
  ignored: "Ignoré"
});

const dom = Object.freeze({
  form: document.querySelector("#search-form"),
  service: document.querySelector("#service"),
  target: document.querySelector("#target"),
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
  sort: document.querySelector("#sort"),
  notice: document.querySelector("#notice"),
  exportButton: document.querySelector("#export-button"),
  newSearch: document.querySelector("#new-search")
});

const state = {
  items: loadStoredItems(),
  noticeTimer: null,
  isLoading: false
};

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
    typeof item.score === "number" &&
    item.score >= 0 &&
    item.score <= 100 &&
    typeof item.status === "string"
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
    showNotice("Le navigateur n’a pas pu enregistrer les résultats localement.", "warning");
  }
}

function showNotice(message, kind = "info") {
  window.clearTimeout(state.noticeTimer);
  dom.notice.textContent = message;
  dom.notice.dataset.kind = kind;
  dom.notice.hidden = false;
  state.noticeTimer = window.setTimeout(() => {
    dom.notice.hidden = true;
  }, 8000);
}

function setProgress(percent, message) {
  dom.progress.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  dom.progressText.textContent = message;
}

function setLoading(isLoading) {
  state.isLoading = isLoading;
  dom.launch.disabled = isLoading;
  dom.launch.textContent = isLoading ? "Recherche en cours…" : "Trouver et classer les entreprises";
}

function sanitizePlainText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeIdentifier(value, maxLength) {
  return String(value ?? "").replace(/\D/g, "").slice(0, maxLength);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function fetchJson(url, options = {}, retryCount = 1) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "strict-origin-when-cross-origin",
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    if (response.status === 429 && retryCount > 0) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(Number.isFinite(retryAfter) ? Math.min(5000, Math.max(500, retryAfter * 1000)) : 1200);
      return fetchJson(url, options, retryCount - 1);
    }

    if (!response.ok) throw new Error(`Service distant indisponible (${response.status}).`);

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Le service distant a renvoyé une réponse inattendue.");
    }

    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Le service distant a dépassé le délai autorisé.");
    }
    if (error instanceof TypeError) {
      throw new Error("Le service public est momentanément inaccessible depuis le navigateur.");
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

  const data = await fetchJson(`${CONFIG.nominatimEndpoint}?${params.toString()}`);
  const result = Array.isArray(data) ? data[0] : null;
  if (!result) throw new Error("Zone introuvable en France.");

  const latitude = normalizeNumber(result.lat);
  const longitude = normalizeNumber(result.lon);
  if (latitude === null || longitude === null) throw new Error("Coordonnées géographiques invalides.");

  return {
    latitude,
    longitude,
    label: sanitizePlainText(result.display_name, 200)
  };
}

function buildCompanySearchUrl({ geo, formData, page }) {
  const sections = CATEGORY_SECTIONS[formData.category] || CATEGORY_SECTIONS.artisans;
  const params = new URLSearchParams({
    lat: geo.latitude.toFixed(6),
    long: geo.longitude.toFixed(6),
    radius: String(formData.radiusKm),
    page: String(page),
    per_page: String(CONFIG.companyPageSize),
    limite_matching_etablissements: "25",
    section_activite_principale: sections.join(",")
  });
  return `${CONFIG.companySearchEndpoint}?${params.toString()}`;
}

async function fetchCompaniesNearPoint(geo, formData) {
  const requestedPages = Math.min(CONFIG.maxRemotePages, Math.ceil(formData.limit / CONFIG.companyPageSize));
  const results = [];

  for (let page = 1; page <= requestedPages; page += 1) {
    setProgress(24 + page * 18, `Récupération des entreprises — page ${page}/${requestedPages}…`);
    const data = await fetchJson(buildCompanySearchUrl({ geo, formData, page }));
    const pageResults = Array.isArray(data?.results) ? data.results : [];
    results.push(...pageResults);
    const totalPages = normalizeNumber(data?.total_pages, requestedPages);
    if (pageResults.length < CONFIG.companyPageSize || page >= totalPages) break;
    await delay(220);
  }

  return results;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return sanitizePlainText(value, 240);
  }
  return null;
}

function firstArrayString(value) {
  return Array.isArray(value) ? firstNonEmptyString(...value) : null;
}

function selectLocalEstablishment(company) {
  const matching = Array.isArray(company?.matching_etablissements) ? company.matching_etablissements : [];
  return matching.find((establishment) => establishment?.etat_administratif === "A") || matching[0] || company?.siege || {};
}

function yearsSince(dateValue) {
  const timestamp = Date.parse(dateValue);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 31557600000));
}

function isSmallWorkforceCode(code) {
  if (!code) return true;
  return ["NN", "00", "01", "02", "03", "11", "12", "21"].includes(String(code).toUpperCase());
}

function calculateOpportunity(company, establishment) {
  let score = 28;
  const reasons = [];
  const positives = [];
  const creationDate = firstNonEmptyString(establishment?.date_creation, company?.date_creation);
  const age = yearsSince(creationDate);
  const openEstablishments = normalizeNumber(company?.nombre_etablissements_ouverts, 1);
  const totalEstablishments = normalizeNumber(company?.nombre_etablissements, openEstablishments);
  const workforceCode = firstNonEmptyString(establishment?.tranche_effectif_salarie, company?.tranche_effectif_salarie);
  const companyCategory = firstNonEmptyString(company?.categorie_entreprise);
  const isIndividual = company?.complements?.est_entrepreneur_individuel === true || company?.est_entrepreneur_individuel === true;

  if (age !== null && age <= 2) {
    score += 25;
    reasons.push("Entreprise créée récemment");
  } else if (age !== null && age <= 5) {
    score += 16;
    reasons.push("Entreprise en phase de développement");
  } else if (age !== null) {
    positives.push(`Activité établie depuis ${age} ans`);
  }

  if (openEstablishments <= 1) {
    score += 17;
    reasons.push("Structure locale avec un seul établissement ouvert");
  } else if (openEstablishments <= 3) {
    score += 9;
    reasons.push("Petite implantation locale");
  } else {
    positives.push(`${openEstablishments} établissements ouverts`);
  }

  if (isSmallWorkforceCode(workforceCode)) {
    score += 12;
    reasons.push("Effectif compatible avec une TPE ou petite structure");
  }

  if (companyCategory === "PME") {
    score += 6;
    positives.push("Catégorie PME");
  }

  if (isIndividual) {
    score += 5;
    reasons.push("Décisionnaire probablement proche de l’activité");
  }

  if (establishment?.etat_administratif === "A" || company?.etat_administratif === "A") {
    score += 4;
    positives.push("Établissement déclaré actif");
  }

  if (!firstNonEmptyString(establishment?.nom_commercial, firstArrayString(establishment?.liste_enseignes))) {
    score += 4;
    reasons.push("Enseigne commerciale non renseignée dans le registre");
  }

  const confidencePoints = [company?.siren, establishment?.siret, establishment?.adresse, creationDate, establishment?.activite_principale].filter(Boolean).length;

  return {
    score: Math.max(1, Math.min(96, Math.round(score))),
    reasons: reasons.slice(0, 5),
    positives: positives.slice(0, 3),
    confidence: confidencePoints >= 4 ? "Élevée" : confidencePoints >= 2 ? "Moyenne" : "Faible",
    creationDate,
    age,
    openEstablishments,
    totalEstablishments
  };
}

function createMessage(prospect, service) {
  const evidence = prospect.reasons.length ? prospect.reasons.slice(0, 2).join(" et ").toLowerCase() : "une activité locale correspondant à mon domaine d’intervention";
  const locality = prospect.city ? ` à ${prospect.city}` : " dans votre secteur";
  return [
    "Bonjour,",
    "",
    `J’ai découvert ${prospect.name}${locality} dans les données publiques de l’Annuaire des Entreprises. Votre structure présente ${evidence}.`,
    "",
    `Je propose ${sanitizePlainText(service, 160).toLowerCase()} pour aider les entreprises locales à améliorer leur visibilité et leurs prises de contact. Je peux vous transmettre gratuitement un diagnostic rapide et concret, sans engagement.`,
    "",
    "Seriez-vous disponible pour un échange de 15 minutes ?",
    "",
    "Bien cordialement,"
  ].join("\n");
}

function createSearchUrl(prospect) {
  return `https://www.google.com/search?q=${encodeURIComponent([prospect.name, prospect.city, prospect.address].filter(Boolean).join(" "))}`;
}

function mapCompanyToProspect(company, service) {
  if (!company || typeof company !== "object") return null;
  const establishment = selectLocalEstablishment(company);
  const siren = normalizeIdentifier(company.siren, 9);
  const siret = normalizeIdentifier(establishment?.siret, 14);
  if (!siren && !siret) return null;

  const name = firstNonEmptyString(establishment?.nom_commercial, firstArrayString(establishment?.liste_enseignes), company?.nom_complet, company?.nom_raison_sociale);
  if (!name) return null;

  const activitySection = firstNonEmptyString(company?.section_activite_principale);
  const activityCode = firstNonEmptyString(establishment?.activite_principale, company?.siege?.activite_principale);
  const activityLabel = ACTIVITY_LABELS[activitySection] || "Entreprise locale";
  const opportunity = calculateOpportunity(company, establishment);

  const prospect = {
    id: siret ? `siret-${siret}` : `siren-${siren}`,
    name,
    type: activityCode ? `${activityLabel} · APE ${activityCode}` : activityLabel,
    activityCode,
    activitySection,
    address: firstNonEmptyString(establishment?.adresse, company?.siege?.adresse) || "Adresse non renseignée",
    city: firstNonEmptyString(establishment?.libelle_commune, company?.siege?.libelle_commune, establishment?.commune),
    website: null,
    phone: null,
    email: null,
    siren,
    siret,
    latitude: normalizeNumber(establishment?.latitude),
    longitude: normalizeNumber(establishment?.longitude),
    score: opportunity.score,
    reasons: opportunity.reasons,
    positives: opportunity.positives,
    confidence: opportunity.confidence,
    creationDate: opportunity.creationDate,
    age: opportunity.age,
    openEstablishments: opportunity.openEstablishments,
    totalEstablishments: opportunity.totalEstablishments,
    status: "new",
    source: "Annuaire des Entreprises — données INSEE",
    capturedAt: new Date().toISOString()
  };

  prospect.searchUrl = createSearchUrl(prospect);
  prospect.message = createMessage(prospect, service);
  return prospect;
}

function deduplicateProspects(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function discoverProspects(formData) {
  setProgress(8, "Localisation de la zone…");
  const geo = await geocodeLocation(formData.location);
  setProgress(22, "Interrogation de l’Annuaire des Entreprises…");
  const companies = await fetchCompaniesNearPoint(geo, formData);
  setProgress(76, "Calcul du potentiel commercial…");
  const prospects = deduplicateProspects(companies.map((company) => mapCompanyToProspect(company, formData.service)).filter(Boolean));
  prospects.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
  return { geo, prospects: prospects.slice(0, formData.limit) };
}

function readFormData() {
  const service = sanitizePlainText(dom.service.value, 160);
  const target = sanitizePlainText(dom.target.value, 120);
  const location = sanitizePlainText(dom.location.value, 120);
  const category = Object.hasOwn(CATEGORY_SECTIONS, dom.category.value) ? dom.category.value : "artisans";
  const radiusKm = Math.max(1, Math.min(CONFIG.maxRadiusKm, Number(dom.radius.value) || 20));
  const limit = Math.max(5, Math.min(CONFIG.maxResults, Number(dom.resultLimit.value) || CONFIG.maxResults));
  if (service.length < 3) throw new Error("Décris plus précisément le service vendu.");
  if (target.length < 2) throw new Error("Décris la cible commerciale.");
  if (location.length < 2) throw new Error("Indique une ville ou une zone valide.");
  return { service, target, location, category, radiusKm, limit };
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

function createSignalTag(text, variant = "") {
  return createElement("span", { className: `signal-tag${variant ? ` ${variant}` : ""}`, text });
}

function formatDate(dateValue) {
  const timestamp = Date.parse(dateValue);
  if (!Number.isFinite(timestamp)) return "Non renseignée";
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(timestamp));
}

function createProspectCard(prospect) {
  const article = createElement("article", { className: "result-card" });
  const summary = createElement("div");
  summary.append(createElement("h3", { text: prospect.name }));
  summary.append(createElement("div", { className: "result-subtitle", text: `${prospect.type} · ${prospect.address} · Confiance ${prospect.confidence.toLowerCase()}` }));

  const signals = createElement("div", { className: "signal-list" });
  for (const reason of prospect.reasons) signals.append(createSignalTag(reason, "warning"));
  for (const positive of prospect.positives) signals.append(createSignalTag(positive, "positive"));
  summary.append(signals);

  const scoreBlock = createElement("div", { className: "score-block" });
  const scoreClass = prospect.score < 50 ? "low" : prospect.score < 75 ? "medium" : "";
  scoreBlock.append(createElement("span", { className: `opportunity-score${scoreClass ? ` ${scoreClass}` : ""}`, text: `${prospect.score}/100` }));
  scoreBlock.append(createElement("small", { text: "potentiel commercial" }));

  const details = createElement("details", { className: "result-details" });
  details.append(createElement("summary", { text: "Voir les preuves et préparer le contact" }));
  const detailGrid = createElement("div", { className: "detail-grid" });
  const evidenceColumn = createElement("div");
  evidenceColumn.append(createElement("h4", { text: "Données publiques vérifiables" }));
  evidenceColumn.append(createElement("p", { text: [prospect.siren ? `SIREN : ${prospect.siren}` : null, prospect.siret ? `SIRET local : ${prospect.siret}` : null, prospect.activityCode ? `Code APE : ${prospect.activityCode}` : null, `Création : ${formatDate(prospect.creationDate)}`, `Établissements ouverts : ${prospect.openEstablishments ?? "Non renseigné"}`, `Source : ${prospect.source}`].filter(Boolean).join(" · ") }));
  evidenceColumn.append(createElement("p", { text: "Le registre ne fournit pas le site, le téléphone ou l’email. Vérifie ces coordonnées avant tout contact." }));

  const messageColumn = createElement("div");
  messageColumn.append(createElement("h4", { text: "Message proposé" }));
  const textarea = createElement("textarea", { className: "message-box", attributes: { "aria-label": `Message pour ${prospect.name}`, maxlength: "4000" } });
  textarea.value = prospect.message;
  textarea.addEventListener("input", () => {
    prospect.message = textarea.value.slice(0, 4000);
    persistItems();
  });
  messageColumn.append(textarea);
  detailGrid.append(evidenceColumn, messageColumn);
  details.append(detailGrid);

  const actions = createElement("div", { className: "card-actions" });
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

  actions.append(createElement("a", { className: "secondary-button", text: "Rechercher le site et les coordonnées", attributes: { href: prospect.searchUrl, target: "_blank", rel: "noopener noreferrer nofollow" } }));

  if (prospect.latitude !== null && prospect.longitude !== null) {
    const mapUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(prospect.latitude)}&mlon=${encodeURIComponent(prospect.longitude)}#map=18/${encodeURIComponent(prospect.latitude)}/${encodeURIComponent(prospect.longitude)}`;
    actions.append(createElement("a", { className: "secondary-button", text: "Voir sur la carte", attributes: { href: mapUrl, target: "_blank", rel: "noopener noreferrer" } }));
  }

  const statusSelect = createElement("select", { className: "status-select", attributes: { "aria-label": `Statut de ${prospect.name}` } });
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
  const query = sanitizePlainText(dom.filter.value, 120).toLocaleLowerCase("fr");
  const sortMode = dom.sort.value;
  const items = state.items.filter((item) => {
    if (!query) return true;
    return [item.name, item.type, item.address, item.siren, item.siret, ...item.reasons].filter(Boolean).join(" ").toLocaleLowerCase("fr").includes(query);
  });

  return items.toSorted((a, b) => {
    if (sortMode === "name") return a.name.localeCompare(b.name, "fr");
    if (sortMode === "recent") return (Date.parse(b.creationDate) || 0) - (Date.parse(a.creationDate) || 0) || b.score - a.score;
    return b.score - a.score || a.name.localeCompare(b.name, "fr");
  });
}

function render() {
  const items = getVisibleItems();
  dom.count.textContent = `${items.length} prospect${items.length > 1 ? "s" : ""}`;
  dom.results.replaceChildren();
  if (!items.length) {
    const empty = createElement("div", { className: "empty-state" });
    empty.append(createElement("strong", { text: "Aucun prospect à afficher." }));
    empty.append(createElement("p", { text: "Lance une recherche par activité et zone géographique pour obtenir un classement automatique." }));
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

  const rows = [
    ["Entreprise", "Activité", "Adresse", "SIREN", "SIRET", "Date de création", "Établissements ouverts", "Score", "Confiance", "Signaux", "Statut", "Source"],
    ...state.items.map((item) => [item.name, item.type, item.address, item.siren || "", item.siret || "", item.creationDate || "", item.openEstablishments ?? "", item.score, item.confidence, item.reasons.join(" | "), STATUS_LABELS[item.status] || STATUS_LABELS.new, item.source])
  ];

  const csv = rows.map((row) => row.map(quoteCsv).join(";")).join("\r\n");
  const downloadUrl = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
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
    setProgress(100, `${state.items.length} entreprises classées autour de ${result.geo.label}.`);
    showNotice(state.items.length ? `${state.items.length} entreprises françaises trouvées et classées depuis les données publiques officielles.` : "Aucune entreprise correspondante n’a été trouvée. Augmente le rayon ou choisis une autre catégorie.", state.items.length ? "success" : "warning");
  } catch (error) {
    setProgress(0, "La recherche n’a pas abouti.");
    showNotice(error instanceof Error ? error.message : "Une erreur inattendue est survenue.", "error");
  } finally {
    setLoading(false);
  }
}

dom.form.addEventListener("submit", handleSubmit);
dom.filter.addEventListener("input", render);
dom.sort.addEventListener("change", render);
dom.exportButton.addEventListener("click", exportCsv);
dom.newSearch.addEventListener("click", () => {
  dom.service.focus();
  dom.form.scrollIntoView({ behavior: "smooth", block: "start" });
});

render();
