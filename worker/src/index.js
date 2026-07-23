const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});

const MAX_BUSINESSES = 10;
const MAX_REQUEST_BYTES = 64_000;
const MAX_HTML_BYTES = 750_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const CACHE_TTL_SECONDS = 86_400;

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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
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
  const leftTokens = new Set(normalizeText(left).split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(normalizeText(right).split(" ").filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;

  let common = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) common += 1;
  }
  return common / Math.max(leftTokens.size, rightTokens.size);
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
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

async function applyRateLimit(request, env, route) {
  if (!env.RATE_LIMITER) return true;
  const actor = request.headers.get("CF-Connecting-IP") || "anonymous";
  const result = await env.RATE_LIMITER.limit({ key: `${route}:${actor}` });
  return result.success;
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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

  return `[out:json][timeout:20];(${statements.join("")});out center tags 2500;`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: options.redirect || "manual"
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HttpError(504, "Le service distant a dépassé le délai autorisé.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getFirstTag(tags, keys) {
  for (const key of keys) {
    const value = tags?.[key];
    if (typeof value === "string" && value.trim()) return sanitizeText(value, 400);
  }
  return null;
}

function mapOsmElements(payload) {
  const elements = Array.isArray(payload?.elements) ? payload.elements : [];

  return elements.map((element) => {
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
      : distance <= 0.5
        ? 1
        : distance <= 2
          ? 0.75
          : distance <= 5
            ? 0.35
            : 0;
    const score = nameScore * 0.72 + distanceScore * 0.22 + cityScore * 0.06;

    if (!best || score > best.score) best = { record, score, distance };
  }

  if (!best || best.score < 0.48 || (best.distance !== null && best.distance > 6)) return null;
  return best;
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
  if (!SEGMENTS[segment]) throw new HttpError(400, "Segment invalide.");

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
  const cacheKey = new Request(`https://cache.signallead.local/enrich/${hashString(query)}`);
  const cache = caches.default;
  let overpassResponse = await cache.match(cacheKey);

  if (!overpassResponse) {
    const endpoint = env.OVERPASS_ENDPOINT || "https://overpass.kumi.systems/api/interpreter";
    const params = new URLSearchParams({ data: query });
    const response = await fetchWithTimeout(`${endpoint}?${params}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SignalLead/1.0 (+https://owarino777.github.io/signal-lead-ai/)"
      }
    }, 20_000);

    if (!response.ok) {
      throw new HttpError(502, `OpenStreetMap est indisponible (${response.status}).`);
    }

    const body = await response.text();
    overpassResponse = new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
      }
    });
    await cache.put(cacheKey, overpassResponse.clone());
  }

  let overpassPayload;
  try {
    overpassPayload = await overpassResponse.json();
  } catch {
    throw new HttpError(502, "OpenStreetMap a renvoyé une réponse invalide.");
  }

  const records = mapOsmElements(overpassPayload);
  const results = normalizedBusinesses.map((business) => {
    const match = matchRecord(business, records);
    if (!match) {
      return { id: business.id, found: false, confidence: 0 };
    }

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

  return json({ results }, 200, corsHeaders(origin));
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
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return null;
    if (isPrivateIpv4(hostname)) return null;
    if (hostname.includes(":")) return null;
    url.hash = "";
    return url.href.slice(0, 2048);
  } catch {
    return null;
  }
}

async function readTextLimited(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "Le HTML du site dépasse la taille autorisée.");
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

async function fetchPublicHtml(initialUrl) {
  let currentUrl = normalizePublicUrl(initialUrl);
  if (!currentUrl) throw new HttpError(400, "URL publique invalide.");
  let redirects = 0;
  const startedAt = Date.now();

  while (redirects <= MAX_REDIRECTS) {
    const response = await fetchWithTimeout(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; SignalLeadAudit/1.0; +https://owarino777.github.io/signal-lead-ai/)"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      if (!location) throw new HttpError(502, "Redirection sans destination.");
      currentUrl = normalizePublicUrl(new URL(location, currentUrl).href);
      if (!currentUrl) throw new HttpError(400, "La redirection pointe vers une destination interdite.");
      redirects += 1;
      continue;
    }

    const contentType = response.headers.get("Content-Type") || "";
    if (!response.ok) throw new HttpError(502, `Le site a répondu ${response.status}.`);
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new HttpError(415, "La ressource trouvée n’est pas une page HTML.");
    }

    const declaredLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
      throw new HttpError(413, "Le HTML du site dépasse la taille autorisée.");
    }

    const html = await readTextLimited(response, MAX_HTML_BYTES);
    return {
      url: currentUrl,
      status: response.status,
      responseTimeMs: Date.now() - startedAt,
      redirects,
      headers: response.headers,
      html
    };
  }

  throw new HttpError(508, "Trop de redirections.");
}

function firstMatch(source, expression) {
  const match = source.match(expression);
  return sanitizeText(match?.[1], 500) || null;
}

function detectTechnologies(html) {
  const source = html.toLowerCase();
  const technologies = new Set();
  if (/wp-content|wp-includes|wordpress/.test(source)) technologies.add("WordPress");
  if (/elementor/.test(source)) technologies.add("Elementor");
  if (/wixstatic|wix-code|wixsite/.test(source)) technologies.add("Wix");
  if (/cdn\.shopify\.com|shopify-section|myshopify/.test(source)) technologies.add("Shopify");
  if (/squarespace/.test(source)) technologies.add("Squarespace");
  if (/webflow/.test(source)) technologies.add("Webflow");
  if (/drupal-settings-json|sites\/default\/files/.test(source)) technologies.add("Drupal");
  if (/joomla|\/media\/system\/js\//.test(source)) technologies.add("Joomla");
  if (/__next_data__|\/_next\//.test(source)) technologies.add("Next.js");
  if (/data-reactroot|react-dom|react\.production/.test(source)) technologies.add("React");
  if (/data-v-|vue\.runtime|__vue__/.test(source)) technologies.add("Vue.js");
  if (/ng-version|angular\.min\.js/.test(source)) technologies.add("Angular");
  if (/bootstrap(?:\.min)?\.css|bootstrap(?:\.bundle)?(?:\.min)?\.js/.test(source)) technologies.add("Bootstrap");
  if (/jquery(?:-|\.)(?:1\.|2\.)/.test(source)) technologies.add("jQuery ancien");
  if (!technologies.size) technologies.add("Technologie non identifiée");
  return [...technologies].slice(0, 12);
}

function countMatches(source, expression) {
  return [...source.matchAll(expression)].length;
}

function analyzeHtml(result, segment) {
  const html = result.html;
  const lower = html.toLowerCase();
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const language = firstMatch(html, /<html[^>]+lang=["']([^"']+)["']/i);
  const h1Count = countMatches(html, /<h1\b[^>]*>/gi);
  const formCount = countMatches(html, /<form\b[^>]*>/gi);
  const telephoneLinks = countMatches(html, /<a[^>]+href=["']tel:/gi);
  const structuredData = /<script[^>]+type=["']application\/ld\+json["']/i.test(html);
  const text = normalizeText(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));
  const conversionWords = segment === "building"
    ? ["devis", "contact", "appel", "realisation", "projet"]
    : ["commander", "commande", "livraison", "reserver", "reservation", "menu", "contact"];
  const conversionHits = conversionWords.filter((word) => text.includes(word)).length;
  const technologies = detectTechnologies(html);

  let mobile = viewport ? 85 : 28;
  let seo = 25;
  if (title && title.length >= 15 && title.length <= 70) seo += 30;
  else if (title) seo += 15;
  if (description && description.length >= 70) seo += 25;
  else if (description) seo += 10;
  if (h1Count === 1) seo += 12;
  if (structuredData) seo += 8;

  let structure = 30;
  if (language) structure += 12;
  if (/<main\b/i.test(html)) structure += 16;
  if (/<nav\b/i.test(html)) structure += 10;
  if (/<header\b/i.test(html)) structure += 7;
  if (/<footer\b/i.test(html)) structure += 7;
  if (h1Count === 1) structure += 8;

  let conversion = 20 + Math.min(36, conversionHits * 9);
  if (formCount > 0) conversion += 18;
  if (telephoneLinks > 0) conversion += 16;

  const transport = result.responseTimeMs <= 800
    ? 95
    : result.responseTimeMs <= 1500
      ? 75
      : result.responseTimeMs <= 3000
        ? 50
        : 25;

  const securityHeaders = {
    hsts: Boolean(result.headers.get("Strict-Transport-Security")),
    csp: Boolean(result.headers.get("Content-Security-Policy")),
    nosniff: /nosniff/i.test(result.headers.get("X-Content-Type-Options") || "")
  };

  let security = result.url.startsWith("https://") ? 55 : 15;
  if (securityHeaders.hsts) security += 15;
  if (securityHeaders.csp) security += 15;
  if (securityHeaders.nosniff) security += 15;

  mobile = clamp(mobile);
  seo = clamp(seo);
  structure = clamp(structure);
  conversion = clamp(conversion);
  security = clamp(security);

  const quality = clamp(
    mobile * 0.2
    + seo * 0.22
    + structure * 0.18
    + conversion * 0.25
    + transport * 0.08
    + security * 0.07
  );

  const evidence = [];
  if (!viewport) evidence.push("Configuration mobile non détectée");
  if (!title) evidence.push("Titre de page absent");
  if (!description) evidence.push("Description SEO absente");
  if (h1Count !== 1) evidence.push("Structure du titre principal perfectible");
  if (!formCount && !telephoneLinks) evidence.push("Prise de contact peu visible");
  if (!conversionHits) evidence.push("Aucun appel à l’action métier clairement détecté");
  if (technologies.includes("jQuery ancien")) evidence.push("Bibliothèque JavaScript ancienne détectée");
  if (quality >= 78) evidence.push("Fondations techniques globalement satisfaisantes");

  return {
    auditedAt: new Date().toISOString(),
    finalUrl: result.url,
    status: result.status,
    responseTimeMs: result.responseTimeMs,
    redirects: result.redirects,
    title,
    description,
    technologies,
    metrics: { mobile, seo, structure, conversion, transport, security },
    securityHeaders,
    quality,
    siteNeed: clamp(100 - quality),
    evidence: evidence.slice(0, 8)
  };
}

async function auditWebsite(request, env, origin) {
  const payload = await readJsonBody(request);
  const url = normalizePublicUrl(payload?.url);
  const segment = sanitizeText(payload?.segment, 30);
  if (!url) throw new HttpError(400, "URL invalide ou interdite.");
  if (!SEGMENTS[segment]) throw new HttpError(400, "Segment invalide.");

  const cacheKey = new Request(`https://cache.signallead.local/audit/${hashString(`${url}|${segment}`)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: 200,
      headers: { ...JSON_HEADERS, ...corsHeaders(origin), "X-SignalLead-Cache": "HIT" }
    });
  }

  const result = await fetchPublicHtml(url);
  const audit = analyzeHtml(result, segment);
  const body = JSON.stringify({ audit });
  await cache.put(cacheKey, new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
    }
  }));

  return new Response(body, {
    status: 200,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin), "X-SignalLead-Cache": "MISS" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") && !origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.headers.get("Origin") && !origin) {
      return json({ error: "Origine non autorisée." }, 403);
    }

    try {
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ status: "ok", service: "signal-lead-api" }, 200, cors);
      }

      if (request.method !== "POST") {
        return json({ error: "Méthode non autorisée." }, 405, cors);
      }

      const rateAllowed = await applyRateLimit(request, env, url.pathname);
      if (!rateAllowed) return json({ error: "Trop de requêtes. Réessaie dans une minute." }, 429, cors);

      if (url.pathname === "/api/enrich") return await enrichBusinesses(request, env, origin);
      if (url.pathname === "/api/audit") return await auditWebsite(request, env, origin);
      return json({ error: "Route inconnue." }, 404, cors);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Erreur interne.";
      return json({ error: sanitizeText(message, 300) }, status, cors);
    }
  }
};
