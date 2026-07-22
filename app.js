"use strict";

const CONFIG = Object.freeze({
  maxResults: 50,
  maxRadiusKm: 50,
  requestTimeoutMs: 25000,
  storageKey: "signalLead.v2.items",
  storageVersion: 2,
  nominatimEndpoint: "https://nominatim.openstreetmap.org/search",
  overpassEndpoints: Object.freeze([
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ])
});

const BUSINESS_TAGS = Object.freeze({
  artisans: [
    ["craft"],
    ["shop", "hardware"],
    ["shop", "car_repair"],
    ["office", "company"]
  ],
  restaurants: [
    ["amenity", "restaurant"],
    ["amenity", "cafe"],
    ["amenity", "fast_food"]
  ],
  commerces: [
    ["shop"],
    ["office", "company"]
  ],
  sante: [
    ["amenity", "clinic"],
    ["amenity", "dentist"],
    ["healthcare"]
  ],
  services: [
    ["office"],
    ["craft"],
    ["amenity", "car_rental"],
    ["amenity", "driving_school"]
  ]
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
  const payload = JSON.stringify({
    version: CONFIG.storageVersion,
    savedAt: new Date().toISOString(),
    items: state.items.slice(0, CONFIG.maxResults)
  });
  localStorage.setItem(CONFIG.storageKey, payload);
}

function showNotice(message, kind = "info") {
  window.clearTimeout(state.noticeTimer);
  dom.notice.textContent = message;
  dom.notice.dataset.kind = kind;
  dom.notice.hidden = false;
  state.noticeTimer = window.setTimeout(() => {
    dom.notice.hidden = true;
  }, 6500);
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

function sanitizePlainText(value, maxLength = 180) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^0\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true;
  return false;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`Service distant indisponible (${response.status}).`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Réponse distante inattendue.");
    }
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
  const data = await fetchJson(`${CONFIG.nominatimEndpoint}?${params.toString()}`);
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
    label: sanitizePlainText(result.display_name, 200)
  };
}

function escapeOverpassString(value) {
  return String(value).replace(/[\\"]/g, "");
}

function buildOverpassQuery({ latitude, longitude, radiusKm, category }) {
  const radiusMeters = Math.round(Math.max(1, Math.min(CONFIG.maxRadiusKm, radiusKm)) * 1000);
  const pairs = BUSINESS_TAGS[category] || BUSINESS_TAGS.artisans;
  const selectors = pairs.flatMap(([key, value]) => {
    const condition = value ? `["${escapeOverpassString(key)}"="${escapeOverpassString(value)}"]` : `["${escapeOverpassString(key)}"]`;
    const around = `(around:${radiusMeters},${latitude.toFixed(6)},${longitude.toFixed(6)})`;
    return [`node${condition}${around};`, `way${condition}${around};`, `relation${condition}${around};`];
  });
  return `[out:json][timeout:22];(${selectors.join("")});out center tags ${CONFIG.maxResults * 4};`;
}

async function queryOverpass(query) {
  let lastError = null;
  for (const endpoint of CONFIG.overpassEndpoints) {
    try {
      const params = new URLSearchParams({ data: query });
      return await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: params.toString()
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Aucun serveur Overpass disponible.");
}

function getFirstTag(tags, names) {
  for (const name of names) {
    const value = tags[name];
    if (typeof value === "string" && value.trim()) return sanitizePlainText(value, 240);
  }
  return null;
}

function inferBusinessType(tags) {
  return sanitizePlainText(
    tags.craft || tags.shop || tags.office || tags.amenity || tags.healthcare || "Entreprise locale",
    80
  ).replaceAll("_", " ");
}

function buildAddress(tags) {
  const parts = [
    [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
    tags["addr:postcode"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"]
  ].filter(Boolean);
  return sanitizePlainText(parts.join(", "), 220) || "Adresse non renseignée";
}

function calculateOpportunityScore(tags, website) {
  let score = 28;
  const reasons = [];
  const positives = [];

  if (!website) {
    score += 31;
    reasons.push("Aucun site web public renseigné");
  } else {
    positives.push("Site web public identifié");
  }

  const phone = getFirstTag(tags, ["contact:phone", "phone"]);
  const email = getFirstTag(tags, ["contact:email", "email"]);
  const openingHours = getFirstTag(tags, ["opening_hours"]);
  const description = getFirstTag(tags, ["description", "note"]);
  const social = getFirstTag(tags, ["contact:facebook", "facebook", "contact:instagram", "instagram"]);

  if (!phone) {
    score += 12;
    reasons.push("Téléphone public absent");
  } else {
    positives.push("Téléphone public disponible");
  }
  if (!email) {
    score += 10;
    reasons.push("Email public absent");
  } else {
    positives.push("Email public disponible");
  }
  if (!openingHours) {
    score += 7;
    reasons.push("Horaires non renseignés");
  }
  if (!description) {
    score += 6;
    reasons.push("Présentation publique très limitée");
  }
  if (!social) {
    score += 4;
    reasons.push("Réseaux sociaux non renseignés");
  }

  const completenessCount = [website, phone, email, openingHours, description, social].filter(Boolean).length;
  if (completenessCount >= 5) {
    score -= 16;
    positives.push("Présence numérique déjà bien renseignée");
  }

  return {
    score: Math.max(1, Math.min(99, Math.round(score))),
    reasons: reasons.slice(0, 5),
    positives: positives.slice(0, 3),
    confidence: website || phone || email ? "Moyenne" : "Faible"
  };
}

function createMessage(prospect, service) {
  const evidence = prospect.reasons.length
    ? prospect.reasons.slice(0, 3).join(", ").toLowerCase()
    : "des informations publiques qui pourraient être enrichies";
  return [
    "Bonjour,",
    "",
    `En consultant les informations publiques de ${prospect.name}, j’ai relevé ${evidence}.`,
    "",
    `Je propose ${sanitizePlainText(service, 160).toLowerCase()} afin d’améliorer la visibilité locale et de faciliter les prises de contact. Je peux vous transmettre gratuitement un diagnostic synthétique, sans engagement.`,
    "",
    "Seriez-vous disponible pour un échange de 15 minutes ?",
    "",
    "Bien cordialement,"
  ].join("\n");
}

function mapElementToProspect(element, service) {
  const tags = element && typeof element.tags === "object" ? element.tags : {};
  const name = getFirstTag(tags, ["name", "brand", "operator"]);
  if (!name) return null;

  const website = normalizeExternalUrl(getFirstTag(tags, ["contact:website", "website", "url"]));
  const opportunity = calculateOpportunityScore(tags, website);
  const phone = getFirstTag(tags, ["contact:phone", "phone"]);
  const email = getFirstTag(tags, ["contact:email", "email"]);
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);

  const prospect = {
    id: `${sanitizePlainText(element.type, 16)}-${String(element.id).slice(0, 32)}`,
    name,
    type: inferBusinessType(tags),
    address: buildAddress(tags),
    website,
    phone,
    email,
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    score: opportunity.score,
    reasons: opportunity.reasons,
    positives: opportunity.positives,
    confidence: opportunity.confidence,
    status: "new",
    source: "OpenStreetMap",
    capturedAt: new Date().toISOString()
  };
  prospect.message = createMessage(prospect, service);
  return prospect;
}

function deduplicateProspects(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = `${item.name.toLocaleLowerCase("fr")}|${item.address.toLocaleLowerCase("fr")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

async function discoverProspects(formData) {
  setProgress(8, "Localisation de la zone…");
  const geo = await geocodeLocation(formData.location);

  setProgress(28, "Recherche des entreprises publiques…");
  const query = buildOverpassQuery({
    latitude: geo.latitude,
    longitude: geo.longitude,
    radiusKm: formData.radiusKm,
    category: formData.category
  });
  const data = await queryOverpass(query);
  const elements = Array.isArray(data.elements) ? data.elements : [];

  setProgress(70, "Calcul des signaux et du classement…");
  const prospects = deduplicateProspects(
    elements.map((element) => mapElementToProspect(element, formData.service)).filter(Boolean)
  );

  prospects.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "fr"));
  return {
    geo,
    prospects: prospects.slice(0, formData.limit)
  };
}

function readFormData() {
  const service = sanitizePlainText(dom.service.value, 160);
  const target = sanitizePlainText(dom.target.value, 120);
  const location = sanitizePlainText(dom.location.value, 120);
  const category = Object.hasOwn(BUSINESS_TAGS, dom.category.value) ? dom.category.value : "artisans";
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
    for (const [name, value] of Object.entries(options.attributes)) {
      element.setAttribute(name, String(value));
    }
  }
  return element;
}

function createSignalTag(text, variant = "") {
  return createElement("span", {
    className: `signal-tag${variant ? ` ${variant}` : ""}`,
    text
  });
}

function createProspectCard(prospect) {
  const article = createElement("article", { className: "result-card" });
  const summary = createElement("div");
  summary.append(createElement("h3", { text: prospect.name }));
  summary.append(createElement("div", {
    className: "result-subtitle",
    text: `${prospect.type} · ${prospect.address} · Confiance ${prospect.confidence.toLowerCase()}`
  }));

  const signals = createElement("div", { className: "signal-list" });
  for (const reason of prospect.reasons) signals.append(createSignalTag(reason, "warning"));
  for (const positive of prospect.positives) signals.append(createSignalTag(positive, "positive"));
  summary.append(signals);

  const scoreBlock = createElement("div", { className: "score-block" });
  const scoreClass = prospect.score < 50 ? "low" : prospect.score < 75 ? "medium" : "";
  scoreBlock.append(createElement("span", {
    className: `opportunity-score${scoreClass ? ` ${scoreClass}` : ""}`,
    text: `${prospect.score}/100`
  }));
  scoreBlock.append(createElement("small", { text: "opportunité estimée" }));

  const details = createElement("details", { className: "result-details" });
  details.append(createElement("summary", { text: "Voir les preuves et préparer le contact" }));
  const detailGrid = createElement("div", { className: "detail-grid" });

  const evidenceColumn = createElement("div");
  evidenceColumn.append(createElement("h4", { text: "Données publiques vérifiables" }));
  const evidenceText = [
    prospect.website ? `Site : ${prospect.website}` : "Site : non renseigné",
    prospect.phone ? `Téléphone : ${prospect.phone}` : "Téléphone : non renseigné",
    prospect.email ? `Email : ${prospect.email}` : "Email : non renseigné",
    `Source : ${prospect.source}`
  ].join(" · ");
  evidenceColumn.append(createElement("p", { text: evidenceText }));

  const messageColumn = createElement("div");
  messageColumn.append(createElement("h4", { text: "Message proposé" }));
  const textarea = createElement("textarea", {
    className: "message-box",
    attributes: { "aria-label": `Message pour ${prospect.name}` }
  });
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

  if (prospect.website) {
    const websiteLink = createElement("a", {
      className: "secondary-button",
      text: "Ouvrir le site",
      attributes: {
        href: prospect.website,
        target: "_blank",
        rel: "noopener noreferrer nofollow"
      }
    });
    actions.append(websiteLink);
  }

  if (prospect.latitude !== null && prospect.longitude !== null) {
    const mapUrl = `https://www.openstreetmap.org/?mlat=${encodeURIComponent(prospect.latitude)}&mlon=${encodeURIComponent(prospect.longitude)}#map=18/${encodeURIComponent(prospect.latitude)}/${encodeURIComponent(prospect.longitude)}`;
    actions.append(createElement("a", {
      className: "secondary-button",
      text: "Voir sur la carte",
      attributes: { href: mapUrl, target: "_blank", rel: "noopener noreferrer" }
    }));
  }

  const statusLabel = createElement("label", { className: "visually-hidden", text: `Statut de ${prospect.name}` });
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
  actions.append(statusLabel, statusSelect);
  details.append(actions);

  article.append(summary, scoreBlock, details);
  return article;
}

function getVisibleItems() {
  const query = sanitizePlainText(dom.filter.value, 120).toLocaleLowerCase("fr");
  const sortMode = dom.sort.value;
  const items = state.items.filter((item) => {
    if (!query) return true;
    return [item.name, item.type, item.address, ...item.reasons]
      .join(" ")
      .toLocaleLowerCase("fr")
      .includes(query);
  });
  return items.toSorted((a, b) => {
    if (sortMode === "name") return a.name.localeCompare(b.name, "fr");
    if (sortMode === "website-missing") return Number(Boolean(a.website)) - Number(Boolean(b.website)) || b.score - a.score;
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
    empty.append(createElement("p", { text: "Lance une recherche par métier et zone géographique pour obtenir un classement automatique." }));
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
    ["Entreprise", "Activité", "Adresse", "Site", "Téléphone", "Email", "Score", "Confiance", "Signaux", "Statut", "Source"],
    ...state.items.map((item) => [
      item.name,
      item.type,
      item.address,
      item.website || "",
      item.phone || "",
      item.email || "",
      item.score,
      item.confidence,
      item.reasons.join(" | "),
      STATUS_LABELS[item.status] || STATUS_LABELS.new,
      item.source
    ])
  ];
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
    setProgress(100, `${state.items.length} entreprises classées autour de ${result.geo.label}.`);
    showNotice(`${state.items.length} entreprises trouvées et classées. Les scores reposent uniquement sur des données publiques vérifiables.`, "success");
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
