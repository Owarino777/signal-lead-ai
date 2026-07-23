const GOOGLE_PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const MAX_BUSINESSES = 10;
const REQUEST_TIMEOUT_MS = 12000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
const rateBuckets = new Map();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function sanitizeText(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalize(value) {
  return sanitizeText(value, 240)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(sarl|sas|sasu|eurl|sa|ei|societe|entreprise|etablissement|france)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function overlapScore(left, right) {
  const a = new Set(normalize(left).split(" ").filter((token) => token.length > 1));
  const b = new Set(normalize(right).split(" ").filter((token) => token.length > 1));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function scoreCandidate(place, business) {
  const expectedName = business.commercialName || business.name;
  const nameScore = overlapScore(expectedName, place.displayName?.text || "");
  const addressScore = overlapScore(`${business.address || ""} ${business.city || ""}`, place.formattedAddress || "");
  const cityBonus = business.city && normalize(place.formattedAddress || "").includes(normalize(business.city)) ? 0.15 : 0;
  return Math.min(1, nameScore * 0.7 + addressScore * 0.3 + cityBonus);
}

function getAllowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const sameOrigin = new URL(request.url).origin;
  const configured = new Set(
    String(process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  configured.add(sameOrigin);
  configured.add("https://owarino777.github.io");
  return configured.has(origin) ? origin : null;
}

function isRateAllowed(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "unknown";
  const ip = forwarded.split(",")[0].trim();
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > 60000) {
    rateBuckets.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 20;
}

async function searchPlace(business, apiKey) {
  const cacheKey = normalize(
    `${business.commercialName || business.name}|${business.address || ""}|${business.city || ""}`
  );
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const query = [
    business.commercialName || business.name,
    business.address,
    business.city,
    "France"
  ].filter(Boolean).join(", ");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GOOGLE_PLACES_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.websiteUri",
          "places.nationalPhoneNumber",
          "places.rating",
          "places.userRatingCount",
          "places.businessStatus",
          "places.googleMapsUri",
          "places.types"
        ].join(",")
      },
      body: JSON.stringify({
        textQuery: query,
        languageCode: "fr",
        regionCode: "FR",
        maxResultCount: 5
      })
    });

    if (!response.ok) {
      throw new Error(`Google Places a répondu ${response.status}.`);
    }

    const data = await response.json();
    const candidates = Array.isArray(data.places) ? data.places : [];
    const ranked = candidates
      .map((place) => ({ place, confidence: scoreCandidate(place, business) }))
      .sort((a, b) => b.confidence - a.confidence);

    const best = ranked[0];
    const value = !best || best.confidence < 0.35
      ? { id: business.id, found: false, confidence: best?.confidence || 0 }
      : {
          id: business.id,
          found: true,
          confidence: Number(best.confidence.toFixed(2)),
          placeId: best.place.id || null,
          matchedName: sanitizeText(best.place.displayName?.text, 200),
          matchedAddress: sanitizeText(best.place.formattedAddress, 260),
          website: best.place.websiteUri || null,
          phone: sanitizeText(best.place.nationalPhoneNumber, 40) || null,
          rating: Number.isFinite(best.place.rating) ? best.place.rating : null,
          reviewCount: Number.isFinite(best.place.userRatingCount) ? best.place.userRatingCount : null,
          businessStatus: best.place.businessStatus || null,
          googleMapsUrl: best.place.googleMapsUri || null,
          types: Array.isArray(best.place.types) ? best.place.types.slice(0, 12) : []
        };

    cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        results[index] = {
          id: items[index]?.id || null,
          error: sanitizeText(error instanceof Error ? error.message : "Erreur d’enrichissement", 240)
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

export default {
  async fetch(request) {
    const allowedOrigin = getAllowedOrigin(request);
    const corsHeaders = allowedOrigin
      ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
      : {};

    if (request.method === "OPTIONS") {
      if (!allowedOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Méthode non autorisée." }, 405, corsHeaders);
    }
    if (!isRateAllowed(request)) {
      return json({ error: "Trop de requêtes. Réessaie dans une minute." }, 429, corsHeaders);
    }
    if (!allowedOrigin && request.headers.get("origin")) {
      return json({ error: "Origine non autorisée." }, 403);
    }

    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return json(
        { error: "GOOGLE_PLACES_API_KEY n’est pas configurée sur le serveur." },
        503,
        corsHeaders
      );
    }

    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 100000) {
      return json({ error: "Requête trop volumineuse." }, 413, corsHeaders);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Corps JSON invalide." }, 400, corsHeaders);
    }

    const businesses = Array.isArray(payload?.businesses)
      ? payload.businesses.slice(0, MAX_BUSINESSES)
      : [];

    const normalized = businesses
      .map((business) => ({
        id: sanitizeText(business?.id, 60),
        name: sanitizeText(business?.name, 200),
        commercialName: sanitizeText(business?.commercialName, 200),
        address: sanitizeText(business?.address, 260),
        city: sanitizeText(business?.city, 120)
      }))
      .filter((business) => business.id && business.name);

    if (!normalized.length) {
      return json({ error: "Aucune entreprise valide à enrichir." }, 400, corsHeaders);
    }

    const results = await mapWithConcurrency(
      normalized,
      3,
      (business) => searchPlace(business, apiKey)
    );

    return json({ results }, 200, corsHeaders);
  }
};
