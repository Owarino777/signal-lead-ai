"use strict";

const CONFIG = Object.freeze({
  maxResults: 50,
  maxRadiusKm: 50,
  requestTimeoutMs: 22000,
  auditTimeoutMs: 60000,
  storageKey: "signalLead.v5.items",
  storageVersion: 5,
  nominatimEndpoint: "https://nominatim.openstreetmap.org/search",
  companyEndpoint: "https://recherche-entreprises.api.gouv.fr/near_point",
  microlinkEndpoint: "https://api.microlink.io/"
});

const SEGMENTS = Object.freeze({
  fastfood: Object.freeze({ label: "Restauration rapide", activityCodes: Object.freeze(["56.10C"]), need: "la commande en ligne et la conversion mobile" }),
  restaurants: Object.freeze({ label: "Restaurant", activityCodes: Object.freeze(["56.10A", "56.10B"]), need: "les réservations, les menus et la visibilité locale" }),
  food: Object.freeze({ label: "Restauration", activityCodes: Object.freeze(["56.10A", "56.10B", "56.10C"]), need: "la réservation, la commande et la visibilité locale" }),
  building: Object.freeze({ label: "Bâtiment", sectionCode: "F", need: "les réalisations, les avis et les demandes de devis" })
});

const STATUS_LABELS = Object.freeze({ new: "Nouveau", contacted: "Contacté", replied: "Répondu", won: "Gagné", ignored: "Ignoré" });
const ASSOCIATION_LEGAL_CODES = new Set(["9210", "9220", "9221", "9222", "9230", "9240", "9260"]);
const PUBLIC_LEGAL_CODE_PREFIXES = Object.freeze(["71", "72", "73", "74"]);
const MANUAL_WEIGHTS = Object.freeze({ datedDesign: 14, poorMobile: 16, weakConversion: 18, weakTrust: 10, confusingNavigation: 10, siteGood: -45 });

const dom = Object.freeze({
  form: document.querySelector("#search-form"), service: document.querySelector("#service"), category: document.querySelector("#category"), location: document.querySelector("#location"), radius: document.querySelector("#radius"), resultLimit: document.querySelector("#result-limit"), launch: document.querySelector("#launch"), progress: document.querySelector("#progress"), progressText: document.querySelector("#progress-text"), results: document.querySelector("#results"), emptyState: document.querySelector("#empty-state"), count: document.querySelector("#result-count"), filter: document.querySelector("#filter"), qualificationFilter: document.querySelector("#qualification-filter"), sort: document.querySelector("#sort"), notice: document.querySelector("#notice"), exportButton: document.querySelector("#export-button"), newSearch: document.querySelector("#new-search"), summaryTotal: document.querySelector("#summary-total"), summaryAudited: document.querySelector("#summary-audited"), summaryHigh: document.querySelector("#summary-high"), summaryPending: document.querySelector("#summary-pending"),
  dialog: document.querySelector("#prospect-dialog"), dialogTitle: document.querySelector("#dialog-title"), dialogSubtitle: document.querySelector("#dialog-subtitle"), dialogSegment: document.querySelector("#dialog-segment"), closeDialog: document.querySelector("#close-dialog"), dialogBusinessScore: document.querySelector("#dialog-business-score"), dialogSiteScore: document.querySelector("#dialog-site-score"), dialogMetrics: document.querySelector("#dialog-metrics"), dialogBusinessEvidence: document.querySelector("#dialog-business-evidence"), siteUrl: document.querySelector("#site-url"), findSite: document.querySelector("#find-site"), saveSite: document.querySelector("#save-site"), auditSite: document.querySelector("#audit-site"), noSiteConfirmed: document.querySelector("#no-site-confirmed"), websitePreview: document.querySelector("#website-preview"), auditMetrics: document.querySelector("#audit-metrics"), technologyList: document.querySelector("#technology-list"), manualReview: document.querySelector(".manual-review"), prospectStatus: document.querySelector("#prospect-status"), contactMessage: document.querySelector("#contact-message"), copyMessage: document.querySelector("#copy-message"), openSite: document.querySelector("#open-site"), saveProspect: document.querySelector("#save-prospect")
});

const state = { items: loadItems(), selectedId: null, isLoading: false, noticeTimer: null };

function sanitizeText(value, max = 200) { return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max); }
function firstDefined(...values) { return values.find((value) => value !== undefined && value !== null && value !== ""); }
function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, Math.round(Number(value) || 0))); }
function normalizeScore(value) { const number = Number(value); if (!Number.isFinite(number)) return null; return clamp(number <= 1 ? number * 100 : number); }

function loadItems() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "null");
    return parsed?.version === CONFIG.storageVersion && Array.isArray(parsed.items) ? parsed.items.filter(isValidItem).slice(0, CONFIG.maxResults) : [];
  } catch { return []; }
}
function isValidItem(item) { return Boolean(item && typeof item.id === "string" && typeof item.name === "string" && Number.isFinite(item.businessScore)); }
function persistItems() {
  try { localStorage.setItem(CONFIG.storageKey, JSON.stringify({ version: CONFIG.storageVersion, savedAt: new Date().toISOString(), items: state.items })); }
  catch { showNotice("Impossible d’enregistrer les résultats dans ce navigateur.", "warning"); }
}
function showNotice(message, kind = "info") {
  clearTimeout(state.noticeTimer);
  dom.notice.textContent = sanitizeText(message, 500);
  dom.notice.dataset.kind = kind;
  dom.notice.hidden = false;
  state.noticeTimer = setTimeout(() => { dom.notice.hidden = true; }, 7000);
}
function setProgress(percent, message) { dom.progress.style.width = `${clamp(percent)}%`; dom.progressText.textContent = message; }
function setLoading(value) { state.isLoading = value; dom.launch.disabled = value; dom.launch.textContent = value ? "Recherche en cours…" : "Lancer la recherche"; }

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
    url.username = ""; url.password = ""; url.hash = "";
    return url.href.slice(0, 2048);
  } catch { return null; }
}
async function fetchJson(url, timeoutMs = CONFIG.requestTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "follow", referrerPolicy: "strict-origin-when-cross-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Service distant indisponible (${response.status}).`);
    return await response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Le service a dépassé le délai autorisé.");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function geocodeLocation(location) {
  const query = sanitizeText(location, 120);
  const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1", addressdetails: "1", countrycodes: "fr" });
  const data = await fetchJson(`${CONFIG.nominatimEndpoint}?${params}`);
  const result = Array.isArray(data) ? data[0] : null;
  if (!result) throw new Error("Zone introuvable en France.");
  const latitude = Number(result.lat); const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error("Coordonnées géographiques invalides.");
  return { latitude, longitude, label: sanitizeText(result.display_name, 200) };
}
function buildCompanyUrl({ geo, radiusKm, segment, page }) {
  const params = new URLSearchParams({ lat: geo.latitude.toFixed(6), long: geo.longitude.toFixed(6), radius: String(Math.min(CONFIG.maxRadiusKm, Math.max(1, radiusKm))), page: String(page), per_page: "25", etat_administratif: "A" });
  if (segment.sectionCode) params.set("section_activite_principale", segment.sectionCode);
  else params.set("activite_principale", segment.activityCodes.join(","));
  return `${CONFIG.companyEndpoint}?${params}`;
}
function getResults(data) { return Array.isArray(data?.results) ? data.results : Array.isArray(data?.resultats) ? data.resultats : []; }
async function fetchCompanies(formData, geo) {
  const segment = SEGMENTS[formData.category];
  const pages = formData.limit > 25 ? [1, 2] : [1];
  const responses = await Promise.all(pages.map((page) => fetchJson(buildCompanyUrl({ geo, radiusKm: formData.radiusKm, segment, page }))));
  return responses.flatMap(getResults);
}

function normalizeLegalCode(value) { return sanitizeText(value, 8).replace(/\D/g, ""); }
function isExcluded(company) {
  const complements = company?.complements || {};
  const legalCode = normalizeLegalCode(firstDefined(company?.nature_juridique, company?.nature_juridique_unite_legale));
  const legalLabel = sanitizeText(firstDefined(company?.libelle_nature_juridique, company?.nature_juridique_libelle), 180).toLowerCase();
  const name = sanitizeText(firstDefined(company?.nom_complet, company?.nom_raison_sociale, company?.sigle), 200).toLowerCase();
  const association = complements.est_association === true || ASSOCIATION_LEGAL_CODES.has(legalCode) || legalLabel.includes("association") || /(^|\s)(association|amicale|club|comité|fédération)(\s|$)/.test(name);
  const publicBody = PUBLIC_LEGAL_CODE_PREFIXES.some((prefix) => legalCode.startsWith(prefix)) || /commune|département|région|établissement public|administration/.test(legalLabel);
  return association || publicBody;
}
function getSite(company) { return company?.siege || company?.matching_etablissements?.[0] || company?.etablissement_siege || {}; }
function getFinancial(company) {
  const finances = company?.finances;
  if (!finances || typeof finances !== "object") return null;
  return Object.entries(finances).map(([year, record]) => ({ year: Number(year), record })).filter((entry) => Number.isFinite(entry.year) && entry.record && typeof entry.record === "object").sort((a, b) => b.year - a.year)[0] || null;
}
function parseMoney(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function employeeMidpoint(code) {
  return ({ "00": 0, "NN": 0, "01": 1, "02": 4, "03": 8, "11": 15, "12": 35, "21": 75, "22": 150, "31": 225, "32": 375, "41": 750, "42": 1500, "51": 3500, "52": 7500, "53": 10000 })[sanitizeText(code, 10).toUpperCase()] ?? null;
}
function formatAddress(site) {
  const direct = firstDefined(site?.adresse, site?.adresse_complete);
  if (direct) return sanitizeText(direct, 240);
  return sanitizeText([[site?.numero_voie, site?.type_voie, site?.libelle_voie].filter(Boolean).join(" "), site?.code_postal, firstDefined(site?.libelle_commune, site?.commune, site?.ville)].filter(Boolean).join(" "), 240) || "Adresse non renseignée";
}
function yearsSince(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : Math.max(0, (Date.now() - date.getTime()) / 31556952000); }

function calculateBusinessFit({ revenue, employees, employer, establishments, ageYears, companyCategory, hasTradeName, segment }) {
  let score = 24;
  const evidence = [];
  if (revenue !== null) {
    if (revenue >= 300000 && revenue <= 8000000) { score += 22; evidence.push("Chiffre d’affaires compatible avec une prestation externe"); }
    else if (revenue > 8000000 && revenue <= 20000000) { score += 12; evidence.push("Capacité d’investissement élevée"); }
    else if (revenue > 20000000) { score -= 12; evidence.push("Structure importante, décision d’achat probablement complexe"); }
    else { score += 6; evidence.push("Chiffre d’affaires public limité"); }
  } else { score += 7; evidence.push("Chiffre d’affaires non publié"); }

  if (employees !== null) {
    if (employees >= 2 && employees <= 20) { score += 20; evidence.push("Taille idéale pour joindre un décideur"); }
    else if (employees > 20 && employees <= 50) { score += 13; evidence.push("PME structurée avec budget probable"); }
    else if (employees > 100) { score -= 16; evidence.push("Grande organisation moins accessible commercialement"); }
    else { score += 6; }
  }
  if (employer) { score += 7; evidence.push("Statut employeur confirmé"); }
  if (establishments >= 1 && establishments <= 5) { score += 10; evidence.push("Réseau local de taille accessible"); }
  else if (establishments > 20) { score -= 14; evidence.push("Réseau important probablement déjà accompagné"); }
  else if (establishments > 5) { score += 3; }
  if (ageYears !== null && ageYears >= 1 && ageYears <= 15) { score += 9; evidence.push("Entreprise installée et encore en développement"); }
  else if (ageYears !== null && ageYears < 1) { score += 3; evidence.push("Entreprise très récente"); }
  if (hasTradeName) { score += 5; evidence.push("Enseigne commerciale identifiable"); }
  if (["ETI", "GE"].includes(companyCategory)) { score -= 18; evidence.push(`Catégorie ${companyCategory}, cible moins accessible`); }
  if (["fastfood", "restaurants", "food", "building"].includes(segment)) score += 6;
  return { score: clamp(score), evidence: evidence.slice(0, 6) };
}
function createMessage(prospect, service) {
  const siteSentence = prospect.noSiteConfirmed ? "Je n’ai pas identifié de site officiel à jour." : prospect.siteNeed?.score >= 60 ? "L’analyse de votre site fait ressortir plusieurs pistes concrètes d’amélioration." : "Votre présence numérique peut être examinée afin d’identifier les améliorations réellement rentables.";
  return ["Bonjour,", "", `Je me permets de vous contacter au sujet de ${prospect.commercialName || prospect.name}.`, "", `${siteSentence} Dans votre secteur, ${SEGMENTS[prospect.segment].need} ont un impact direct sur les demandes clients.`, "", `Je propose ${sanitizeText(service, 160).toLowerCase()} et peux vous transmettre un diagnostic court, fondé sur des éléments vérifiables.`, "", "Seriez-vous disponible pour un échange de 15 minutes ?", "", "Bien cordialement,"].join("\n");
}
function mapCompany(company, formData) {
  if (!company || isExcluded(company)) return null;
  const site = getSite(company); const financialEntry = getFinancial(company); const financial = financialEntry?.record || {};
  const revenue = parseMoney(firstDefined(financial.ca, financial.chiffre_affaires, financial.chiffre_affaires_net));
  const netResult = parseMoney(firstDefined(financial.resultat_net, financial.resultat));
  const employeeCode = firstDefined(company.tranche_effectif_salarie, site.tranche_effectif_salarie);
  const employees = employeeMidpoint(employeeCode);
  const employer = firstDefined(company.caractere_employeur, site.caractere_employeur) === "O" || firstDefined(company.est_employeur, company?.complements?.est_employeur) === true;
  const establishments = Number(firstDefined(company.nombre_etablissements_ouverts, company.nombre_etablissements, 1)) || 1;
  const companyCategory = sanitizeText(firstDefined(company.categorie_entreprise, company?.complements?.categorie_entreprise), 20).toUpperCase() || "Inconnue";
  const creationDate = sanitizeText(firstDefined(company.date_creation, company.date_creation_unite_legale, site.date_creation), 20) || null;
  const commercialName = sanitizeText(firstDefined(site.enseigne, site.nom_commercial, company.nom_commercial), 180) || null;
  const name = sanitizeText(firstDefined(company.nom_complet, company.nom_raison_sociale, commercialName, company.sigle), 200);
  if (!name) return null;
  const business = calculateBusinessFit({ revenue, employees, employer, establishments, ageYears: creationDate ? yearsSince(creationDate) : null, companyCategory, hasTradeName: Boolean(commercialName), segment: formData.category });
  const prospect = { id: sanitizeText(firstDefined(company.siren, site.siret, crypto.randomUUID()), 40), name, commercialName, activityLabel: sanitizeText(firstDefined(company.libelle_activite_principale, site.libelle_activite_principale, SEGMENTS[formData.category].label), 180), activityCode: sanitizeText(firstDefined(company.activite_principale, site.activite_principale), 12), address: formatAddress(site), city: sanitizeText(firstDefined(site.libelle_commune, site.commune), 120), siren: sanitizeText(company.siren, 12), siret: sanitizeText(site.siret, 18), legalForm: sanitizeText(firstDefined(company.libelle_nature_juridique, company.nature_juridique), 180), creationDate, establishments, employees, employer, companyCategory, revenue, netResult, financialYear: financialEntry?.year || null, businessScore: business.score, businessEvidence: business.evidence, website: null, noSiteConfirmed: false, audit: null, manualIssues: [], siteNeed: null, finalPriority: null, status: "new", segment: formData.category, service: formData.service, capturedAt: new Date().toISOString() };
  prospect.message = createMessage(prospect, formData.service);
  return prospect;
}
function deduplicate(items) { const seen = new Set(); return items.filter((item) => { const key = item.siren || item.siret || `${item.name}|${item.address}`; if (seen.has(key)) return false; seen.add(key); return true; }); }

function calculateSiteNeed(prospect) {
  if (prospect.noSiteConfirmed) return { score: 92, label: "Aucun site confirmé", confidence: "Élevée", evidence: ["Absence de site confirmée manuellement"] };
  if (!prospect.audit) return null;
  let score = 15; const evidence = [];
  const { performance, seo, accessibility, bestPractices, title, description } = prospect.audit;
  if (performance !== null) { if (performance < 45) { score += 30; evidence.push("Performance mobile très faible"); } else if (performance < 65) { score += 20; evidence.push("Performance mobile faible"); } else if (performance < 80) { score += 9; evidence.push("Performance mobile perfectible"); } else { score -= 6; } }
  if (seo !== null) { if (seo < 65) { score += 18; evidence.push("Fondations SEO faibles"); } else if (seo < 80) { score += 8; evidence.push("SEO perfectible"); } else { score -= 4; } }
  if (accessibility !== null) { if (accessibility < 70) { score += 12; evidence.push("Accessibilité technique faible"); } else if (accessibility < 85) { score += 5; } }
  if (bestPractices !== null && bestPractices < 70) { score += 10; evidence.push("Bonnes pratiques techniques insuffisantes"); }
  if (!title) { score += 7; evidence.push("Titre de page absent ou non détecté"); }
  if (!description) { score += 6; evidence.push("Description de page absente ou non détectée"); }
  for (const issue of prospect.manualIssues || []) { score += MANUAL_WEIGHTS[issue] || 0; }
  if (prospect.manualIssues?.includes("siteGood")) evidence.push("Contrôle manuel : site déjà professionnel");
  const finalScore = clamp(score);
  const label = finalScore >= 70 ? "Refonte probable" : finalScore >= 45 ? "Améliorations utiles" : "Site plutôt satisfaisant";
  return { score: finalScore, label, confidence: prospect.manualIssues?.length ? "Élevée" : "Moyenne", evidence: evidence.slice(0, 7) };
}
function updatePriority(prospect) {
  prospect.siteNeed = calculateSiteNeed(prospect);
  prospect.finalPriority = prospect.siteNeed ? clamp(prospect.businessScore * .42 + prospect.siteNeed.score * .58) : null;
  prospect.message = createMessage(prospect, prospect.service || "création et refonte de sites web");
}

function readForm() {
  const service = sanitizeText(dom.service.value, 160); const location = sanitizeText(dom.location.value, 120); const category = Object.hasOwn(SEGMENTS, dom.category.value) ? dom.category.value : "fastfood";
  const radiusKm = Math.min(CONFIG.maxRadiusKm, Math.max(1, Number(dom.radius.value) || 20)); const limit = Math.min(CONFIG.maxResults, Math.max(10, Number(dom.resultLimit.value) || 50));
  if (service.length < 3) throw new Error("Décris le service vendu."); if (location.length < 2) throw new Error("Indique une ville ou une zone.");
  return { service, location, category, radiusKm, limit };
}
async function searchProspects(event) {
  event.preventDefault(); if (state.isLoading) return;
  try {
    const formData = readForm(); setLoading(true); setProgress(8, "Localisation de la zone…"); const geo = await geocodeLocation(formData.location);
    setProgress(30, "Recherche des entreprises actives…"); const companies = await fetchCompanies(formData, geo);
    setProgress(72, "Exclusion des structures non ciblées et calcul du potentiel…");
    const prospects = deduplicate(companies.map((company) => mapCompany(company, formData)).filter(Boolean)).sort((a, b) => b.businessScore - a.businessScore).slice(0, formData.limit);
    state.items = prospects; persistItems(); render(); setProgress(100, `${prospects.length} entreprises trouvées autour de ${geo.label}.`); showNotice(`${prospects.length} entreprises trouvées. Vérifie ensuite leur site pour valider la priorité.`, "success");
  } catch (error) { setProgress(0, "La recherche n’a pas abouti."); showNotice(error instanceof Error ? error.message : "Erreur inattendue.", "error"); }
  finally { setLoading(false); }
}

function formatMoney(value) { return Number.isFinite(value) ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value) : "Non publié"; }
function formatDate(value) { if (!value) return "Non renseignée"; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("fr-FR").format(date); }
function getSiteStatus(prospect) { if (prospect.noSiteConfirmed) return { label: "Aucun site confirmé", className: "bad" }; if (prospect.audit) return { label: "Site analysé", className: "good" }; if (prospect.website) return { label: "URL enregistrée", className: "neutral" }; return { label: "À rechercher", className: "pending" }; }
function getPriorityStatus(prospect) { if (prospect.finalPriority === null) return { label: "Non validée", className: "pending" }; if (prospect.finalPriority >= 70) return { label: `${prospect.finalPriority}/100`, className: "bad" }; if (prospect.finalPriority >= 50) return { label: `${prospect.finalPriority}/100`, className: "neutral" }; return { label: `${prospect.finalPriority}/100`, className: "good" }; }

function getVisibleItems() {
  const query = sanitizeText(dom.filter.value, 120).toLowerCase(); const qualification = dom.qualificationFilter.value; const sort = dom.sort.value;
  const items = state.items.filter((item) => {
    if (query && ![item.name, item.commercialName, item.city, item.address, item.activityLabel].join(" ").toLowerCase().includes(query)) return false;
    if (qualification === "high" && !(item.finalPriority >= 70)) return false;
    if (qualification === "audited" && !(item.audit || item.noSiteConfirmed)) return false;
    if (qualification === "pending" && (item.audit || item.noSiteConfirmed)) return false;
    return true;
  });
  return items.sort((a, b) => {
    if (sort === "business") return b.businessScore - a.businessScore;
    if (sort === "site") return (b.siteNeed?.score ?? -1) - (a.siteNeed?.score ?? -1);
    if (sort === "revenue") return (b.revenue ?? -1) - (a.revenue ?? -1);
    if (sort === "name") return (a.commercialName || a.name).localeCompare(b.commercialName || b.name, "fr");
    return (b.finalPriority ?? -1) - (a.finalPriority ?? -1) || b.businessScore - a.businessScore;
  });
}
function createCell(label) { const cell = document.createElement("td"); cell.dataset.label = label; return cell; }
function createBadge(label, className) { const badge = document.createElement("span"); badge.className = `status-badge ${className}`; badge.textContent = label; return badge; }
function render() {
  const visible = getVisibleItems(); dom.results.replaceChildren(); dom.emptyState.hidden = visible.length > 0; dom.count.textContent = `${visible.length} entreprise${visible.length > 1 ? "s" : ""}`;
  const audited = state.items.filter((item) => item.audit || item.noSiteConfirmed).length; const high = state.items.filter((item) => item.finalPriority >= 70).length;
  dom.summaryTotal.textContent = String(state.items.length); dom.summaryAudited.textContent = String(audited); dom.summaryHigh.textContent = String(high); dom.summaryPending.textContent = String(state.items.length - audited);
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const row = document.createElement("tr");
    const companyCell = createCell("Entreprise"); companyCell.className = "company-cell"; const name = document.createElement("strong"); name.textContent = item.commercialName || item.name; const meta = document.createElement("span"); meta.textContent = `${item.activityLabel || SEGMENTS[item.segment].label} · ${item.city || item.address}`; companyCell.append(name, meta);
    const businessCell = createCell("Potentiel"); businessCell.append(Object.assign(document.createElement("span"), { className: "score-value", textContent: `${item.businessScore}/100` }), Object.assign(document.createElement("span"), { className: "score-caption", textContent: item.employees && item.employees > 100 ? "structure peu accessible" : "adéquation commerciale" }));
    const siteCell = createCell("Site internet"); const siteStatus = getSiteStatus(item); siteCell.append(createBadge(siteStatus.label, siteStatus.className));
    const needCell = createCell("Besoin web"); needCell.append(item.siteNeed ? createBadge(`${item.siteNeed.score}/100 · ${item.siteNeed.label}`, item.siteNeed.score >= 60 ? "bad" : "good") : createBadge("À auditer", "pending"));
    const priorityCell = createCell("Priorité"); const priority = getPriorityStatus(item); priorityCell.append(createBadge(priority.label, priority.className));
    const actionCell = createCell("Actions"); actionCell.className = "row-actions"; const button = document.createElement("button"); button.className = "button button-secondary"; button.type = "button"; button.textContent = "Qualifier"; button.addEventListener("click", () => openProspect(item.id)); actionCell.append(button);
    row.append(companyCell, businessCell, siteCell, needCell, priorityCell, actionCell); fragment.append(row);
  }
  dom.results.append(fragment);
}

function createMetric(label, value) { const box = document.createElement("div"); box.className = "metric"; const span = document.createElement("span"); span.textContent = label; const strong = document.createElement("strong"); strong.textContent = value; box.append(span, strong); return box; }
function selectedProspect() { return state.items.find((item) => item.id === state.selectedId) || null; }
function openProspect(id) { state.selectedId = id; syncDialog(); dom.dialog.showModal(); }
function syncDialog() {
  const item = selectedProspect(); if (!item) return;
  dom.dialogTitle.textContent = item.commercialName || item.name; dom.dialogSubtitle.textContent = `${item.activityLabel} · ${item.address}`; dom.dialogSegment.textContent = SEGMENTS[item.segment]?.label || "Prospect"; dom.dialogBusinessScore.textContent = `${item.businessScore}/100`;
  dom.dialogMetrics.replaceChildren(createMetric("SIREN", item.siren || "Non renseigné"), createMetric("Création", formatDate(item.creationDate)), createMetric("Effectif estimé", item.employees !== null ? String(item.employees) : "Non publié"), createMetric("Établissements", String(item.establishments)), createMetric("Chiffre d’affaires", formatMoney(item.revenue)), createMetric("Résultat net", formatMoney(item.netResult)), createMetric("Catégorie", item.companyCategory), createMetric("Employeur", item.employer ? "Oui" : "Non confirmé"));
  dom.dialogBusinessEvidence.replaceChildren(); for (const evidence of item.businessEvidence) { const chip = document.createElement("span"); chip.className = "evidence-chip"; chip.textContent = evidence; dom.dialogBusinessEvidence.append(chip); }
  dom.siteUrl.value = item.website || ""; dom.noSiteConfirmed.checked = Boolean(item.noSiteConfirmed); dom.prospectStatus.value = item.status || "new"; dom.contactMessage.value = item.message || ""; dom.openSite.hidden = !item.website; if (item.website) dom.openSite.href = item.website;
  for (const input of dom.manualReview.querySelectorAll('input[type="checkbox"]')) input.checked = item.manualIssues?.includes(input.value) || false;
  renderAudit(item);
}
function renderAudit(item) {
  dom.dialogSiteScore.className = `score-pill${item.siteNeed ? "" : " neutral"}`; dom.dialogSiteScore.textContent = item.siteNeed ? `${item.siteNeed.score}/100` : "À vérifier";
  dom.websitePreview.replaceChildren();
  if (item.audit?.screenshot) { const image = document.createElement("img"); image.src = item.audit.screenshot; image.alt = `Capture du site ${item.website || item.name}`; image.referrerPolicy = "no-referrer"; dom.websitePreview.append(image); }
  else { const placeholder = document.createElement("div"); placeholder.className = "preview-placeholder"; const strong = document.createElement("strong"); strong.textContent = "Aperçu indisponible"; const paragraph = document.createElement("p"); paragraph.textContent = "Enregistre une URL puis lance l’analyse pour obtenir une capture du site."; placeholder.append(strong, paragraph); dom.websitePreview.append(placeholder); }
  dom.auditMetrics.replaceChildren();
  const metrics = [["Performance", item.audit?.performance], ["SEO", item.audit?.seo], ["Accessibilité", item.audit?.accessibility], ["Bonnes pratiques", item.audit?.bestPractices]];
  for (const [label, value] of metrics) { const box = document.createElement("div"); box.className = "audit-metric"; const span = document.createElement("span"); span.textContent = label; const strong = document.createElement("strong"); strong.textContent = value === null || value === undefined ? "—" : `${value}/100`; box.append(span, strong); dom.auditMetrics.append(box); }
  dom.technologyList.replaceChildren();
  const technologies = item.audit?.technologies || [];
  if (!technologies.length) { const small = document.createElement("small"); small.textContent = item.audit ? "Aucune technologie reconnue" : "Non analysées"; dom.technologyList.append(small); }
  else for (const technology of technologies) { const tag = document.createElement("span"); tag.className = "tech-tag"; tag.textContent = technology; dom.technologyList.append(tag); }
}
function getGoogleSearchUrl(item) { return `https://www.google.com/search?q=${encodeURIComponent(`${item.commercialName || item.name} ${item.city || item.address} site officiel`)}`; }
function saveCurrentDialog() {
  const item = selectedProspect(); if (!item) return;
  const normalized = normalizeUrl(dom.siteUrl.value.trim());
  if (dom.siteUrl.value.trim() && !normalized) { showNotice("L’URL du site n’est pas valide ou pointe vers un réseau privé.", "warning"); return; }
  item.website = normalized; item.noSiteConfirmed = dom.noSiteConfirmed.checked; if (item.noSiteConfirmed) { item.website = null; item.audit = null; }
  item.manualIssues = [...dom.manualReview.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  item.status = Object.hasOwn(STATUS_LABELS, dom.prospectStatus.value) ? dom.prospectStatus.value : "new"; item.message = dom.contactMessage.value.slice(0, 4000);
  updatePriority(item); persistItems(); syncDialog(); render(); showNotice("Prospect mis à jour.", "success");
}

function recursiveFindScore(root, names) {
  const visited = new Set();
  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) return null;
    visited.add(value);
    for (const name of names) {
      const candidate = value[name];
      if (typeof candidate === "number") return normalizeScore(candidate);
      if (candidate && typeof candidate === "object" && typeof candidate.score === "number") return normalizeScore(candidate.score);
    }
    for (const child of Object.values(value)) { const result = walk(child, depth + 1); if (result !== null) return result; }
    return null;
  }
  return walk(root);
}
function extractTechnologies(payload) {
  const output = new Set(); const visited = new Set();
  function walk(value, key = "", depth = 0) {
    if (!value || depth > 7) return;
    if (typeof value === "string" && /technolog|framework|cms|platform|library/i.test(key) && value.length < 80) output.add(sanitizeText(value, 80));
    if (typeof value !== "object" || visited.has(value)) return; visited.add(value);
    if (Array.isArray(value)) { for (const item of value) { if (typeof item === "string" && item.length < 80) output.add(sanitizeText(item, 80)); else if (item?.name) output.add(sanitizeText(item.name, 80)); else walk(item, key, depth + 1); } }
    else for (const [childKey, child] of Object.entries(value)) { if (/technolog|framework|cms|platform|library/i.test(childKey)) walk(child, childKey, depth + 1); else if (depth < 4) walk(child, childKey, depth + 1); }
  }
  walk(payload); return [...output].filter(Boolean).slice(0, 12);
}
async function resolveInsights(payload) {
  const insights = payload?.insights;
  if (insights?.url && /^https:\/\//i.test(insights.url)) { try { return await fetchJson(insights.url, CONFIG.auditTimeoutMs); } catch { return insights; } }
  return insights || payload;
}
async function auditCurrentSite() {
  const item = selectedProspect(); if (!item) return;
  const website = normalizeUrl(dom.siteUrl.value.trim() || item.website);
  if (!website) { showNotice("Enregistre d’abord l’URL officielle du site.", "warning"); return; }
  dom.auditSite.disabled = true; dom.auditSite.textContent = "Analyse en cours…";
  try {
    const params = new URLSearchParams({ url: website, screenshot: "true", insights: "true" });
    const response = await fetchJson(`${CONFIG.microlinkEndpoint}?${params}`, CONFIG.auditTimeoutMs);
    if (response?.status && response.status !== "success") throw new Error(response?.message || "Le site n’a pas pu être analysé.");
    const payload = response?.data || response; const insights = await resolveInsights(payload);
    item.website = website; item.noSiteConfirmed = false;
    item.audit = { auditedAt: new Date().toISOString(), screenshot: normalizeUrl(firstDefined(payload?.screenshot?.url, payload?.screenshot, payload?.image?.url)) || null, title: sanitizeText(firstDefined(payload?.title, payload?.data?.title), 240) || null, description: sanitizeText(firstDefined(payload?.description, payload?.data?.description), 500) || null, performance: recursiveFindScore(insights, ["performance"]), seo: recursiveFindScore(insights, ["seo"]), accessibility: recursiveFindScore(insights, ["accessibility"]), bestPractices: recursiveFindScore(insights, ["best-practices", "bestPractices", "best_practices"]), technologies: extractTechnologies({ payload, insights }) };
    updatePriority(item); persistItems(); syncDialog(); render(); showNotice("Site analysé. Vérifie aussi visuellement la capture avant de contacter l’entreprise.", "success");
  } catch (error) {
    showNotice(error instanceof Error ? `${error.message} Le quota gratuit d’analyse peut être atteint.` : "Analyse impossible.", "error");
  } finally { dom.auditSite.disabled = false; dom.auditSite.textContent = "Analyser le site"; }
}

function csvValue(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function exportCsv() {
  if (!state.items.length) { showNotice("Aucun résultat à exporter.", "warning"); return; }
  const rows = [["Entreprise", "Enseigne", "Activité", "Ville", "SIREN", "Site", "Potentiel entreprise", "Besoin site", "Priorité validée", "Performance", "SEO", "Technologies", "CA", "Effectif", "Statut"], ...state.items.map((item) => [item.name, item.commercialName, item.activityLabel, item.city, item.siren, item.website, item.businessScore, item.siteNeed?.score ?? "", item.finalPriority ?? "", item.audit?.performance ?? "", item.audit?.seo ?? "", item.audit?.technologies?.join(" | ") || "", item.revenue ?? "", item.employees ?? "", STATUS_LABELS[item.status] || "Nouveau"])];
  const blob = new Blob(["\ufeff", rows.map((row) => row.map(csvValue).join(";")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `signallead-${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function closeDialog() { dom.dialog.close(); state.selectedId = null; }
dom.form.addEventListener("submit", searchProspects);
dom.filter.addEventListener("input", render); dom.qualificationFilter.addEventListener("change", render); dom.sort.addEventListener("change", render);
dom.exportButton.addEventListener("click", exportCsv); dom.newSearch.addEventListener("click", () => document.querySelector("#search").scrollIntoView({ behavior: "smooth" }));
dom.closeDialog.addEventListener("click", closeDialog); dom.dialog.addEventListener("click", (event) => { if (event.target === dom.dialog) closeDialog(); });
dom.findSite.addEventListener("click", () => { const item = selectedProspect(); if (item) window.open(getGoogleSearchUrl(item), "_blank", "noopener,noreferrer"); });
dom.saveSite.addEventListener("click", saveCurrentDialog); dom.saveProspect.addEventListener("click", saveCurrentDialog); dom.auditSite.addEventListener("click", auditCurrentSite);
dom.copyMessage.addEventListener("click", async () => { try { await navigator.clipboard.writeText(dom.contactMessage.value); showNotice("Message copié.", "success"); } catch { dom.contactMessage.select(); showNotice("Le texte est sélectionné : copie-le manuellement.", "warning"); } });
dom.noSiteConfirmed.addEventListener("change", () => { if (dom.noSiteConfirmed.checked) dom.siteUrl.value = ""; });
dom.manualReview.addEventListener("change", () => { const item = selectedProspect(); if (!item) return; item.manualIssues = [...dom.manualReview.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value); updatePriority(item); dom.dialogSiteScore.textContent = item.siteNeed ? `${item.siteNeed.score}/100` : "À vérifier"; });

render();
