import originalWorker from "./index.js";

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});

const MAX_BUSINESSES = 50;
const MAX_REQUEST_BYTES = 128_000;
const CACHE_TTL_SECONDS = 86_400;
const OVERPASS_TIMEOUT_MS = 9_000;

const DEFAULT_OVERPASS_ENDPOINTS = Object.freeze([
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
]);

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
  return sanitizeText(value, 500)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(sarl|sas|sasu|eurl|sa|ei|societe|entreprise|etablissement|france|groupe|holding)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(left, right) {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return 0.88;

  const leftTokens = new Set(normalizedLeft.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(normalizedRight.split(" ").filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;

  let common = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) common += 1;
  }
  return common / Math.max(leftTokens.size, rightTokens.size);
}

function hashString(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
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

function buildOverpassQuery(latitude, longitude, radiusKm, segment) {
  const radiusMeters = Math.round(Math.min(50, Math.max(1, radiusKm)) * 1000);
  const around = `(around:${radiusMeters},${latitude.toFixed(6)},${longitude.toFixed(6)})`;

  const statements = {
    fastfood: [
      `nwr${around}["name"]["amenity"="fast_food"];`,
      `nwr${around}["name"]["cuisine"~"(^|;)(kebab|burger|pizza)(;|$)",i];`
    ],
    restaurants: [
      `nwr${around}["name"]["amenity"~"^(restaurant|cafe)$"];`
    ],
    food: [
      `nwr${around}["name"]["amenity"~"^(restaurant|fast_food|cafe)$"];`
    ],
    building: [
      `nwr${around}["name"]["craft"~"^(plumber|electrician|carpenter|roofer|painter|bricklayer|builder)$"];`,
      `nwr${around}["name"]["office"="construction_company"];`
    ]
  }[segment];

  if (!statements) throw new HttpError(400, "Segment invalide.");
  return `[out:json][timeout:12][maxsize:8388608];(${statements.join("")});out center tags qt 3000;`;
}

function getOverpassEndpoints(env) {
  const configured = String(env.OVERPASS_ENDPOINTS || env.OVERPASS_ENDPOINT || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace("overpass.kumi.systems", "overpass.private.coffee"));

  return [...new Set([...configured, ...DEFAULT_OVERPASS_ENDPOINTS])];
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

async function fetchOverpass(query, env) {
  const errors = [];
  for (const endpoint of getOverpassEndpoints(env)) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "SignalLead/1.0 (+https://owarino777.github.io/signal-lead-ai/)"
        },
        body: new URLSearchParams({ data: query }).toString(),
        redirect: "follow"
      }, OVERPASS_TIMEOUT_MS);

      if (!response.ok) {
        errors.push(`${new URL(endpoint).hostname}: HTTP ${response.status}`);
        continue;
      }

      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        errors.push(`${new URL(endpoint).hostname}: réponse JSON invalide`);
        continue;
      }

      if (!Array.isArray(payload?.elements)) {
        errors.push(`${new URL(endpoint).hostname}: données absentes`);
        continue;
      }

      return {
        payload,
        endpoint,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      const reason = error?.name === "AbortError" ? "délai dépassé" : "erreur réseau";
      errors.push(`${new URL(endpoint).hostname}: ${reason}`);
    }
  }

  throw new HttpError(
    503,
    `OpenStreetMap est temporairement indisponible. ${errors.join(" ; ")}`
  );
}

function getFirstTag(tags, keys) {
  for (const key of keys) {
    const value = tags?.[key];
    if (typeof value === "string" && value.trim()) return sanitizeText(value, 400);
  }
  return null;
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
    if (isPrivateIpv4(hostname) || hostname.includes(":")) return null;
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

function mapOsmElements(payload) {
  return payload.elements.map((element) => {
    const tags = element?.tags || {};
    const name = getFirstTag(tags, ["name", "brand", "operator"]);
    if (!name) return null;

    const latitude = Number(element.lat ?? element.center?.lat);
    const longitude = Number(element.lon ?? element.center?.lon);
    return {
      name,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      website: normalizePublicUrl(getFirstTag(tags, ["contact:website", "website", "url"])),
      phone: getFirstTag(tags, ["contact:phone", "phone", "contact:mobile", "mobile"]),
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
  }).filter(Boolean);
}

function distanceKm(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
  if (![firstLatitude, firstLongitude, secondLatitude, secondLongitude].every(Number.isFinite)) return null;
  const toRadians = (value) => value * Math.PI / 180;
  const radius = 6371;
  const latitudeDelta = toRadians(secondLatitude - firstLatitude);
  const longitudeDelta = toRadians(secondLongitude - firstLongitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(firstLatitude))
    * Math.cos(toRadians(secondLatitude))
    * Math.sin(longitudeDelta / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchRecord(business, records) {
  const expectedName = business.commercialName || business.name;
  let best = null;

  for (const record of records) {
    const nameScore = tokenSimilarity(expectedName, record.name);
    if (nameScore < 0.35) continue;

    const distance = distanceKm(
      business.latitude,
      business.longitude,
      record.latitude,
      record.longitude
    );
    const cityScore = business.city && record.address
      ? tokenSimilarity(business.city, record.address)
      : 0;
    const distanceScore = distance === null
      ? 0
      : distance <= 0.3
        ? 1
        : distance <= 1
          ? 0.85
          : distance <= 3
            ? 0.55
            : distance <= 6
              ? 0.2
              : 0;
    const score = nameScore * 0.76 + distanceScore * 0.20 + cityScore * 0.04;

    if (!best || score > best.score) best = { record, score, distance };
  }

  if (!best || best.score < 0.54 || (best.distance !== null && best.distance > 6)) return null;
  return best;
}

async function applyRateLimit(request, env) {
  if (!env.RATE_LIMITER) return true;
  const actor = request.headers.get("CF-Connecting-IP") || "anonymous";
  const result = await env.RATE_LIMITER.limit({ key: `/api/enrich:${actor}` });
  return result.success;
}

async function enrichBusinesses(request, env, origin) {
  const payload = await readJsonBody(request);
  const latitude = Number(payload?.geo?.latitude);
  const longitude = Number(payload?.geo?.longitude);
  const radiusKm = Number(payload?.radiusKm || 20);
  const segment = sanitizeText(payload?.segment, 30);
  const businesses = Array.isArray(payload?.businesses)
    ? payload.businesses.slice(0, MAX_BUSINESSES)
    : [];

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new HttpError(400, "Coordonnées géographiques invalides.");
  }

  const normalizedBusinesses = businesses.map((business) => ({
    id: sanitizeText(business?.id, 80),
    name: sanitizeText(business?.name, 220),
    commercialName: sanitizeText(business?.commercialName, 220),
    city: sanitizeText(business?.city, 120),
    latitude: Number(business?.latitude),
    longitude: Number(business?.longitude)
  })).filter((business) => business.id && business.name);

  if (!normalizedBusinesses.length) {
    throw new HttpError(400, "Aucune entreprise valide à enrichir.");
  }

  const query = buildOverpassQuery(latitude, longitude, radiusKm, segment);
  const cacheKey = new Request(`https://cache.signallead.local/osm/${hashString(query)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);

  let overpassPayload;
  let endpoint = "cache";
  let durationMs = 0;
  let cacheStatus = "HIT";

  if (cached) {
    overpassPayload = await cached.json();
  } else {
    const response = await fetchOverpass(query, env);
    overpassPayload = response.payload;
    endpoint = new URL(response.endpoint).hostname;
    durationMs = response.durationMs;
    cacheStatus = "MISS";

    await cache.put(cacheKey, new Response(JSON.stringify(overpassPayload), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
      }
    }));
  }

  const records = mapOsmElements(overpassPayload);
  const results = normalizedBusinesses.map((business) => {
    const match = matchRecord(business, records);
    if (!match) return { id: business.id, found: false, confidence: 0 };

    return {
      id: business.id,
      found: true,
      confidence: Number(match.score.toFixed(2)),
      distanceKm: match.distance === null ? null : Number(match.distance.toFixed(2)),
      matchedName: match.record.name,
      website: match.record.website,
      phone: match.record.phone,
      openingHours: match.record.openingHours,
      social: match.record.social,
      source: "OpenStreetMap"
    };
  });

  return json({
    results,
    meta: {
      endpoint,
      cache: cacheStatus,
      durationMs,
      records: records.length,
      businesses: normalizedBusinesses.length
    }
  }, 200, {
    ...corsHeaders(origin),
    "X-SignalLead-Cache": cacheStatus
  });
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
