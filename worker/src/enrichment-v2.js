import originalWorker from "./index.js";
import {
  normalizeText,
  sanitizeText,
  scorePlaceMatch,
  scoreWebsiteIdentity
} from "./scoring.js";

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});

const SEGMENTS = Object.freeze({
  fastfood: [
    '["amenity"="fast_food"]',
    '["cuisine"="kebab"]',
    '["cuisine"="burger"]',
    '["cuisine"="pizza"]'
  ],
  restaurants: [
    '["amenity"="restaurant"]',
    '["amenity"="cafe"]'
  ],
  food: [
    '["amenity"="restaurant"]',
    '["amenity"="fast_food"]',
    '["amenity"="cafe"]'
  ],
  building: [
    '["craft"="plumber"]',
    '["craft"="electrician"]',
    '["craft"="carpenter"]',
    '["craft"="roofer"]',
    '["craft"="painter"]',
    '["craft"="bricklayer"]',
    '["craft"="builder"]',
    '["office"="construction_company"]'
  ]
});

const MAX_BUSINESSES = 10;
const MAX_REQUEST_BYTES = 96_000;
const MAX_HTML_BYTES = 450_000;
const PAGE_TIMEOUT_MS = 6_000;
const SEARCH_TIMEOUT_MS = 8_000;
const OVERPASS_TIMEOUT_MS = 14_000;
const CACHE_TTL_SECONDS = 86_400;
const MAX_SEARCH_BUDGET = 6;
const MAX_DOMAIN_BUDGET = 5;

const DEFAULT_OVERPASS_ENDPOINTS = Object.freeze([
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter"
]);

const BLOCKED_HOSTS = new Set([
  "localhost",
  "example.com",
  "example.fr"
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
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
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin"
      }
    : {};
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
    if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".local")) return null;
    if (isPrivateIpv4(hostname) || hostname.includes(":")) return null;
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PAGE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HttpError(504, "Le service distant a dépassé le délai autorisé.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response, maximumBytes = MAX_HTML_BYTES) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) break;
      output += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return output + decoder.decode();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
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
  const email = html.match(/href=["']mailto:([^?"']+)/i)?.[1] || null;
  const phone = html.match(/href=["']tel:([^"']+)/i)?.[1] || null;

  return {
    title: sanitizeText(title, 300),
    description: sanitizeText(description, 500),
    text: sanitizeText(visibleText, 35_000),
    email: sanitizeText(email, 180) || null,
    phone: sanitizeText(phone, 60) || null
  };
}

async function fetchPage(urlValue) {
  let currentUrl = normalizePublicUrl(urlValue);
  if (!currentUrl) return null;

  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetchWithTimeout(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.4",
        "User-Agent": "Mozilla/5.0 (compatible; SignalLead/2.0; +https://owarino777.github.io/signal-lead-ai/)"
      },
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: false }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) return null;
      currentUrl = normalizePublicUrl(new URL(location, currentUrl).href);
      if (!currentUrl) return null;
      continue;
    }

    if (!response.ok) return null;
    const contentType = response.headers.get("Content-Type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
    const html = await readLimitedText(response);
    if (html.length < 120) return null;
    return {
      url: normalizePublicUrl(response.url || currentUrl) || currentUrl,
      page: extractPageData(html)
    };
  }

  return null;
}

function distanceKm(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
  if (![firstLatitude, firstLongitude, secondLatitude, secondLongitude].every(Number.isFinite)) return null;
  const toRadians = (value) => value * Math.PI / 180;
  const latitudeDelta = toRadians(secondLatitude - firstLatitude);
  const longitudeDelta = toRadians(secondLongitude - firstLongitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(firstLatitude))
    * Math.cos(toRadians(secondLatitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getFirstTag(tags, keys) {
  for (const key of keys) {
    const value = tags?.[key];
    if (typeof value === "string" && value.trim()) return sanitizeText(value, 400);
  }
  return null;
}

function buildOverpassQuery(latitude, longitude, radiusKm, segment) {
  const selectors = SEGMENTS[segment];
  if (!selectors) throw new HttpError(400, "Segment invalide.");
  const radiusMeters = Math.round(Math.min(50, Math.max(1, radiusKm)) * 1000);
  const around = `(around:${radiusMeters},${latitude.toFixed(6)},${longitude.toFixed(6)})`;
  const statements = selectors.flatMap((selector) => [
    `node${selector}${around};`,
    `way${selector}${around};`,
    `relation${selector}${around};`
  ]);
  return `[out:json][timeout:20];(${statements.join("")});out center tags 3000;`;
}

function mapOsmElements(payload) {
  return (Array.isArray(payload?.elements) ? payload.elements : [])
    .map((entry) => {
      const tags = entry?.tags || {};
      const name = getFirstTag(tags, ["name", "brand", "operator"]);
      if (!name) return null;
      const latitude = Number(entry.lat ?? entry.center?.lat);
      const longitude = Number(entry.lon ?? entry.center?.lon);
      return {
        name,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        website: normalizePublicUrl(getFirstTag(tags, ["contact:website", "website", "url", "contact:url"])),
        phone: getFirstTag(tags, ["contact:phone", "phone", "contact:mobile", "mobile"]),
        email: getFirstTag(tags, ["contact:email", "email"]),
        openingHours: getFirstTag(tags, ["opening_hours"]),
        social: [
          getFirstTag(tags, ["contact:facebook", "facebook"]),
          getFirstTag(tags, ["contact:instagram", "instagram"])
        ].filter(Boolean),
        address: sanitizeText([
          [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
          tags["addr:postcode"],
          tags["addr:city"] || tags["addr:town"] || tags["addr:village"]
        ].filter(Boolean).join(" "), 320)
      };
    })
    .filter(Boolean);
}

async function fetchOverpassRecords(payload, env, ctx) {
  const latitude = Number(payload?.geo?.latitude);
  const longitude = Number(payload?.geo?.longitude);
  const radiusKm = Number(payload?.radiusKm || 20);
  const segment = sanitizeText(payload?.segment, 30);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !SEGMENTS[segment]) return [];

  const query = buildOverpassQuery(latitude, longitude, radiusKm, segment);
  const cacheKey = new Request(`https://cache.signallead.local/osm/${hashString(query)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return mapOsmElements(await cached.json());

  const configured = String(env.OVERPASS_ENDPOINTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const endpoints = configured.length ? configured : DEFAULT_OVERPASS_ENDPOINTS;

  for (const endpoint of endpoints.slice(0, 3)) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "SignalLead/2.0 (+https://owarino777.github.io/signal-lead-ai/)"
        },
        body: new URLSearchParams({ data: query })
      }, OVERPASS_TIMEOUT_MS);

      if (!response.ok) continue;
      const text = await response.text();
      const parsed = JSON.parse(text);
      const cacheResponse = new Response(text, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
        }
      });
      if (ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, cacheResponse));
      else await cache.put(cacheKey, cacheResponse);
      return mapOsmElements(parsed);
    } catch {
      // Try the next public endpoint.
    }
  }

  return [];
}

function normalizeBusinesses(rawBusinesses) {
  return rawBusinesses
    .slice(0, MAX_BUSINESSES)
    .map((business) => ({
      id: sanitizeText(business?.id, 80),
      name: sanitizeText(business?.name, 220),
      commercialName: sanitizeText(business?.commercialName, 220),
      city: sanitizeText(business?.city, 120),
      address: sanitizeText(business?.address, 320),
      phone: sanitizeText(business?.phone, 60),
      latitude: Number(business?.latitude),
      longitude: Number(business?.longitude)
    }))
    .filter((business) => business.id && business.name);
}

function findOsmPlace(business, records) {
  let best = null;
  for (const place of records) {
    const distance = distanceKm(
      business.latitude,
      business.longitude,
      place.latitude,
      place.longitude
    );
    const score = scorePlaceMatch({ business, place, distanceKm: distance });
    if (!score.accepted) continue;
    if (!best || score.score > best.score.score) best = { place, distance, score };
  }
  return best;
}

function buildDomainCandidates(business) {
  const words = normalizeText(business.commercialName || business.name)
    .split(" ")
    .filter((word) => word.length >= 2 && !["sarl", "sas", "sasu", "eurl", "france"].includes(word));
  const slug = words.join("-").slice(0, 55);
  const compact = words.join("").slice(0, 55);
  const city = normalizeText(business.city).replace(/\s+/g, "-").slice(0, 30);
  if (slug.length < 4) return [];

  return [...new Set([
    `https://${slug}.fr/`,
    compact !== slug ? `https://${compact}.fr/` : null,
    city ? `https://${slug}-${city}.fr/` : null,
    `https://${slug}.com/`
  ].filter(Boolean))].slice(0, 4);
}

async function inspectWebsite(business, candidateUrl, source) {
  try {
    const result = await fetchPage(candidateUrl);
    if (!result) return null;
    const identity = scoreWebsiteIdentity({
      business,
      url: result.url,
      ...result.page
    });
    if (!identity.accepted) return null;

    return {
      website: result.url,
      confidence: identity.score,
      source,
      evidence: identity.evidence,
      pageTitle: result.page.title,
      email: result.page.email,
      phone: result.page.phone
    };
  } catch {
    return null;
  }
}

async function searchBraveCandidates(business, env) {
  if (!env.BRAVE_SEARCH_API_KEY) return [];
  const query = `"${business.commercialName || business.name}" "${business.city}" site:.fr`;
  const params = new URLSearchParams({
    q: query,
    count: "5",
    country: "fr",
    search_lang: "fr",
    safesearch: "moderate"
  });

  const response = await fetchWithTimeout(
    `https://api.search.brave.com/res/v1/web/search?${params}`,
    {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY
      }
    },
    SEARCH_TIMEOUT_MS
  );
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return (Array.isArray(payload?.web?.results) ? payload.web.results : [])
    .map((result) => normalizePublicUrl(result?.url))
    .filter(Boolean)
    .slice(0, 4);
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

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, () => worker())
  );
  return results;
}

async function discoverBusinessWebsite(business, osmRecords, env, budgets) {
  const placeMatch = findOsmPlace(business, osmRecords);
  const common = placeMatch
    ? {
        phone: placeMatch.place.phone,
        email: placeMatch.place.email,
        openingHours: placeMatch.place.openingHours,
        social: placeMatch.place.social,
        matchedName: placeMatch.place.name,
        distanceKm: placeMatch.distance === null ? null : Number(placeMatch.distance.toFixed(2)),
        placeConfidence: placeMatch.score.score,
        placeEvidence: placeMatch.score.evidence
      }
    : {};

  if (placeMatch?.place.website) {
    const inspected = await inspectWebsite(business, placeMatch.place.website, "OpenStreetMap");
    if (inspected) return { id: business.id, found: true, ...common, ...inspected };
  }

  if (budgets.search > 0 && env.BRAVE_SEARCH_API_KEY) {
    budgets.search -= 1;
    const candidates = await searchBraveCandidates(business, env).catch(() => []);
    const inspected = await mapWithConcurrency(
      candidates,
      Math.min(3, Math.max(1, candidates.length)),
      (candidate) => inspectWebsite(business, candidate, "Brave Search")
    );
    const best = inspected.filter(Boolean).sort((left, right) => right.confidence - left.confidence)[0];
    if (best) return { id: business.id, found: true, ...common, ...best };
  }

  if (budgets.domain > 0) {
    budgets.domain -= 1;
    const candidates = buildDomainCandidates(business);
    const inspected = await mapWithConcurrency(
      candidates,
      Math.min(3, Math.max(1, candidates.length)),
      (candidate) => inspectWebsite(business, candidate, "Domaine validé automatiquement")
    );
    const best = inspected.filter(Boolean).sort((left, right) => right.confidence - left.confidence)[0];
    if (best) return { id: business.id, found: true, ...common, ...best };
  }

  return {
    id: business.id,
    found: false,
    checked: true,
    placeFound: Boolean(placeMatch),
    ...common
  };
}

async function applyRateLimit(request, env) {
  if (!env.RATE_LIMITER) return true;
  const actor = request.headers.get("CF-Connecting-IP") || "anonymous";
  const result = await env.RATE_LIMITER.limit({ key: `/api/enrich-v2:${actor}` });
  return result.success;
}

async function enrichBusinesses(request, env, origin, ctx) {
  const payload = await readJsonBody(request);
  const businesses = normalizeBusinesses(Array.isArray(payload?.businesses) ? payload.businesses : []);
  if (!businesses.length) throw new HttpError(400, "Aucune entreprise valide à enrichir.");

  const osmRecords = await fetchOverpassRecords(payload, env, ctx);
  const budgets = {
    search: Math.min(MAX_SEARCH_BUDGET, Math.max(0, Number(payload?.searchBudget || 0))),
    domain: Math.min(MAX_DOMAIN_BUDGET, Math.max(0, Number(payload?.domainBudget ?? 3)))
  };

  const results = await mapWithConcurrency(
    businesses,
    4,
    (business) => discoverBusinessWebsite(business, osmRecords, env, budgets)
  );

  return json({
    results,
    meta: {
      strategy: "osm-search-domain-validation",
      businesses: businesses.length,
      osmRecords: osmRecords.length,
      found: results.filter((result) => result.found).length,
      placesMatched: results.filter((result) => result.placeFound || result.found).length,
      webSearchEnabled: Boolean(env.BRAVE_SEARCH_API_KEY)
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
      return await enrichBusinesses(request, env, origin, ctx);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Erreur interne.";
      return json({ error: sanitizeText(message, 500) }, status, cors);
    }
  }
};
