import originalWorker from "./index.js";

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});

const MAX_BUSINESSES = 50;
const MAX_DISCOVERY_BUSINESSES = 8;
const MAX_CANDIDATES_PER_BUSINESS = 3;
const MAX_REQUEST_BYTES = 128_000;
const FETCH_TIMEOUT_MS = 4_500;
const MAX_HTML_BYTES = 350_000;
const DISCOVERY_CONCURRENCY = 5;

const LEGAL_WORDS = new Set([
  "sarl", "sas", "sasu", "eurl", "sa", "ei", "societe", "entreprise",
  "etablissement", "etablissements", "groupe", "holding", "france"
]);

const GENERIC_WORDS = new Set([
  "restaurant", "restauration", "rapide", "sushi", "pizza", "burger",
  "burgers", "kebab", "tacos", "food", "foods", "service", "services",
  "gestion", "company", "compagnie", "chez", "le", "la", "les", "de",
  "du", "des", "and", "et"
]);

const BLOCKED_HOSTS = new Set([
  "example.com", "example.fr", "localhost"
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sanitizeText(value, maxLength = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeText(value) {
  return sanitizeText(value, 2000)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return normalizeText(value)
    .split(" ")
    .filter((word) => word && !LEGAL_WORDS.has(word))
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;

  const allowed = new Set(
    String(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  allowed.add(new URL(request.url).origin);
  return allowed.has(origin) ? origin : null;
}

function corsHeaders(origin) {
  return origin
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin"
      }
    : {};
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Requête trop volumineuse.");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Corps JSON invalide.");
  }

  if (JSON.stringify(payload).length > MAX_REQUEST_BYTES) {
    throw new HttpError(413, "Requête trop volumineuse.");
  }
  return payload;
}

function isPrivateIpv4(hostname) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  return octets[0] === 10
    || octets[0] === 127
    || octets[0] === 0
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function normalizePublicUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (url.port && !["80", "443"].includes(url.port)) return null;
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) return null;
    if (BLOCKED_HOSTS.has(hostname) || isPrivateIpv4(hostname) || hostname.includes(":")) return null;
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function normalizeBusinesses(rawBusinesses) {
  return rawBusinesses
    .slice(0, MAX_BUSINESSES)
    .map((business) => ({
      id: sanitizeText(business?.id, 80),
      name: sanitizeText(business?.name, 220),
      commercialName: sanitizeText(business?.commercialName, 220),
      city: sanitizeText(business?.city, 120)
    }))
    .filter((business) => business.id && business.name);
}

function buildCandidates(business) {
  const displayName = business.commercialName || business.name;
  const slug = slugify(displayName);
  const compact = slug.replace(/-/g, "");
  const city = slugify(business.city);

  if (slug.length < 4) return [];

  const candidates = [
    `https://${slug}.fr/`,
    compact !== slug ? `https://${compact}.fr/` : null,
    city ? `https://${slug}-${city}.fr/` : null
  ].filter(Boolean);

  return [...new Set(candidates)].slice(0, MAX_CANDIDATES_PER_BUSINESS);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneRedirect(url) {
  const firstResponse = await fetchWithTimeout(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "User-Agent": "SignalLead/1.0 (+https://owarino777.github.io/signal-lead-ai/)"
    },
    cf: { cacheTtl: 86400, cacheEverything: false }
  }, FETCH_TIMEOUT_MS);

  if (firstResponse.status < 300 || firstResponse.status >= 400) {
    return firstResponse;
  }

  const location = firstResponse.headers.get("Location");
  const redirectedUrl = location
    ? normalizePublicUrl(new URL(location, url).href)
    : null;
  if (!redirectedUrl) return firstResponse;

  return await fetchWithTimeout(redirectedUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "User-Agent": "SignalLead/1.0 (+https://owarino777.github.io/signal-lead-ai/)"
    },
    cf: { cacheTtl: 86400, cacheEverything: false }
  }, FETCH_TIMEOUT_MS);
}

async function readLimitedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";

  try {
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return result + decoder.decode();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractPageData(html) {
  const title = decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const description = decodeHtml(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1]
      || ""
  );
  const visibleText = decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );

  return {
    title: sanitizeText(title, 300),
    description: sanitizeText(description, 500),
    text: sanitizeText(visibleText, 30_000)
  };
}

function getDistinctiveTokens(business) {
  const normalized = normalizeText(business.commercialName || business.name);
  return normalized
    .split(" ")
    .filter((word) => word.length >= 3 && !LEGAL_WORDS.has(word) && !GENERIC_WORDS.has(word));
}

function scoreCandidate(business, candidateUrl, finalUrl, page) {
  const expected = normalizeText(business.commercialName || business.name);
  const city = normalizeText(business.city);
  const content = normalizeText(`${page.title} ${page.description} ${page.text}`);
  const title = normalizeText(page.title);
  const hostname = new URL(finalUrl || candidateUrl).hostname.replace(/^www\./, "");
  const domainText = normalizeText(hostname.replace(/\.(fr|com|net|org)$/i, ""));
  const distinctiveTokens = getDistinctiveTokens(business);

  if (!content || PARKING_MARKERS.some((marker) => content.includes(marker))) {
    return { accepted: false, score: 0, evidence: [] };
  }

  const matchedTokens = distinctiveTokens.filter((token) => content.includes(token));
  const tokenRatio = distinctiveTokens.length
    ? matchedTokens.length / distinctiveTokens.length
    : 0;
  const exactName = expected.length >= 4 && (title.includes(expected) || content.includes(expected));
  const cityMatch = city.length >= 3 && content.includes(city);
  const domainMatch = distinctiveTokens.some((token) => domainText.includes(token));

  let score = 0;
  if (exactName) score += 0.48;
  score += tokenRatio * 0.30;
  if (domainMatch) score += 0.16;
  if (cityMatch) score += 0.06;

  const accepted = matchedTokens.length > 0
    && score >= 0.58
    && (exactName || tokenRatio >= 0.5);

  const evidence = [];
  if (exactName) evidence.push("Nom de l’entreprise présent dans la page");
  if (domainMatch) evidence.push("Domaine cohérent avec l’enseigne");
  if (cityMatch) evidence.push("Ville retrouvée dans le contenu");

  return {
    accepted,
    score: Math.min(1, score),
    evidence
  };
}

async function inspectCandidate(business, candidateUrl) {
  try {
    const response = await fetchOneRedirect(candidateUrl);
    if (!response.ok) return null;

    const contentType = response.headers.get("Content-Type") || "";
    if (!contentType.toLowerCase().includes("text/html")) return null;

    const html = await readLimitedText(response);
    if (html.length < 120) return null;

    const finalUrl = normalizePublicUrl(response.url || candidateUrl);
    if (!finalUrl) return null;

    const page = extractPageData(html);
    const validation = scoreCandidate(business, candidateUrl, finalUrl, page);
    if (!validation.accepted) return null;

    return {
      website: finalUrl,
      confidence: Number(validation.score.toFixed(2)),
      title: page.title,
      evidence: validation.evidence
    };
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function discoverBusinessWebsite(business) {
  const candidates = buildCandidates(business);
  if (!candidates.length) {
    return { id: business.id, found: false, confidence: 0, checked: true };
  }

  const inspected = await mapWithConcurrency(
    candidates,
    Math.min(3, candidates.length),
    (candidateUrl) => inspectCandidate(business, candidateUrl)
  );

  const best = inspected
    .filter(Boolean)
    .sort((left, right) => right.confidence - left.confidence)[0];

  if (!best) {
    return { id: business.id, found: false, confidence: 0, checked: true };
  }

  return {
    id: business.id,
    found: true,
    confidence: best.confidence,
    matchedName: business.commercialName || business.name,
    website: best.website,
    source: "Validation automatique du domaine",
    evidence: best.evidence,
    pageTitle: best.title
  };
}

async function applyRateLimit(request, env) {
  if (!env.RATE_LIMITER) return true;
  const actor = request.headers.get("CF-Connecting-IP") || "anonymous";
  const result = await env.RATE_LIMITER.limit({ key: `/api/enrich:${actor}` });
  return result.success;
}

async function enrichBusinesses(request, env, origin) {
  const payload = await readJsonBody(request);
  const businesses = normalizeBusinesses(
    Array.isArray(payload?.businesses) ? payload.businesses : []
  );

  if (!businesses.length) {
    throw new HttpError(400, "Aucune entreprise valide à enrichir.");
  }

  const prioritized = businesses.slice(0, MAX_DISCOVERY_BUSINESSES);
  const checkedResults = await mapWithConcurrency(
    prioritized,
    DISCOVERY_CONCURRENCY,
    discoverBusinessWebsite
  );

  const deferredResults = businesses.slice(MAX_DISCOVERY_BUSINESSES).map((business) => ({
    id: business.id,
    found: false,
    confidence: 0,
    deferred: true
  }));

  const results = [...checkedResults, ...deferredResults];
  const foundCount = checkedResults.filter((result) => result.found).length;

  return json({
    results,
    meta: {
      strategy: "validated-domain-discovery",
      businesses: businesses.length,
      checked: prioritized.length,
      deferred: deferredResults.length,
      found: foundCount,
      externalDependency: "none"
    }
  }, 200, corsHeaders(origin));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/enrich") {
      return originalWorker.fetch(request, env, ctx);
    }

    const origin = allowedOrigin(request, env);
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") && !origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.headers.get("Origin") && !origin) {
      return json({ error: "Origine non autorisée." }, 403);
    }
    if (request.method !== "POST") {
      return json({ error: "Méthode non autorisée." }, 405, cors);
    }

    try {
      if (!await applyRateLimit(request, env)) {
        return json({ error: "Trop de requêtes. Réessaie dans une minute." }, 429, cors);
      }
      return await enrichBusinesses(request, env, origin);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Erreur interne.";
      return json({ error: sanitizeText(message, 500) }, status, cors);
    }
  }
};
