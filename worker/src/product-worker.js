import enrichmentWorker from "./enrichment-v2.js";
import { sanitizeText, scoreWebsiteIdentity } from "./scoring.js";

const MAX_HTML_BYTES = 450_000;
const FETCH_TIMEOUT_MS = 7_000;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response) {
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
      if (total > MAX_HTML_BYTES) break;
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
  const text = decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );

  return {
    title: sanitizeText(title, 300),
    description: sanitizeText(description, 500),
    text: sanitizeText(text, 35_000),
    email: sanitizeText(html.match(/href=["']mailto:([^?"']+)/i)?.[1], 180) || null,
    phone: sanitizeText(html.match(/href=["']tel:([^"']+)/i)?.[1], 60) || null
  };
}

async function fetchIdentityPage(urlValue) {
  let currentUrl = normalizePublicUrl(urlValue);
  if (!currentUrl) return null;

  for (let redirects = 0; redirects <= 2; redirects += 1) {
    const response = await fetchWithTimeout(currentUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.4",
        "User-Agent": "Mozilla/5.0 (compatible; SignalLeadIdentity/2.0; +https://owarino777.github.io/signal-lead-ai/)"
      },
      cf: { cacheTtl: 86_400, cacheEverything: false }
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

async function enrichAuditIdentity(response, requestPayload) {
  if (!response.ok) return response;

  const body = await response.json().catch(() => null);
  if (!body?.audit || !requestPayload?.business) {
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: response.headers
    });
  }

  const pageResult = await fetchIdentityPage(body.audit.finalUrl || requestPayload.url).catch(() => null);
  if (!pageResult) {
    body.audit.identity = {
      verified: false,
      confidence: 0,
      evidence: ["Identité du site impossible à vérifier"]
    };
  } else {
    const identity = scoreWebsiteIdentity({
      business: requestPayload.business,
      url: pageResult.url,
      ...pageResult.page
    });
    body.audit.identity = {
      verified: identity.accepted,
      confidence: identity.score,
      evidence: identity.evidence,
      diagnostics: identity.diagnostics
    };
    body.audit.contacts = {
      email: pageResult.page.email,
      phone: pageResult.page.phone
    };
  }

  return new Response(JSON.stringify(body), {
    status: response.status,
    headers: response.headers
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/audit" || request.method !== "POST") {
      return enrichmentWorker.fetch(request, env, ctx);
    }

    let requestPayload = null;
    try {
      requestPayload = await request.clone().json();
    } catch {
      // The delegated worker returns the canonical validation error.
    }

    const response = await enrichmentWorker.fetch(request, env, ctx);
    return enrichAuditIdentity(response, requestPayload);
  }
};
