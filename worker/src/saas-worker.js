import productWorker from "./product-worker.js";
import { sanitizeText } from "./scoring.js";

const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});

const SESSION_DAYS = 30;
const MAX_JSON_BYTES = 1_000_000;
const PASSWORD_ITERATIONS = 310_000;

const PLANS = Object.freeze({
  free: Object.freeze({
    key: "free",
    label: "Découverte",
    priceMonthly: 0,
    searchesPerMonth: 5,
    prospectsPerSearch: 10,
    auditsPerMonth: 20
  }),
  solo: Object.freeze({
    key: "solo",
    label: "Solo",
    priceMonthly: 29,
    searchesPerMonth: 100,
    prospectsPerSearch: 50,
    auditsPerMonth: 600
  }),
  pro: Object.freeze({
    key: "pro",
    label: "Pro",
    priceMonthly: 79,
    searchesPerMonth: 500,
    prospectsPerSearch: 50,
    auditsPerMonth: 3_000
  })
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function monthPeriod() {
  return new Date().toISOString().slice(0, 7);
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
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Stripe-Signature",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin"
      }
    : {};
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function readJsonBody(request, maxBytes = MAX_JSON_BYTES) {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "Requête trop volumineuse.");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Corps JSON invalide.");
  }

  if (JSON.stringify(payload).length > maxBytes) {
    throw new HttpError(413, "Requête trop volumineuse.");
  }
  return payload;
}

function requireDatabase(env) {
  if (!env.DB) throw new HttpError(503, "Base de données non configurée.");
  return env.DB;
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

async function derivePasswordHash(password, saltValue) {
  const salt = typeof saltValue === "string" ? decodeBase64Url(saltValue) : saltValue;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    salt,
    iterations: PASSWORD_ITERATIONS
  }, key, 256);
  return encodeBase64Url(new Uint8Array(bits));
}

function constantTimeEqual(leftValue, rightValue) {
  const left = new TextEncoder().encode(String(leftValue));
  const right = new TextEncoder().encode(String(rightValue));
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function normalizeEmail(value) {
  const email = sanitizeText(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(400, "Adresse e-mail invalide.");
  }
  return email;
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 12 || password.length > 200) {
    throw new HttpError(400, "Le mot de passe doit contenir au moins 12 caractères.");
  }
  return password;
}

function getBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function getSessionUser(request, env, required = true) {
  const db = requireDatabase(env);
  const token = getBearerToken(request);
  if (!token) {
    if (required) throw new HttpError(401, "Connexion requise.");
    return null;
  }

  const tokenHash = await sha256(token);
  const row = await db.prepare(`
    SELECT
      users.id,
      users.email,
      sessions.id AS session_id,
      sessions.expires_at,
      COALESCE(subscriptions.plan, 'free') AS plan,
      COALESCE(subscriptions.status, 'active') AS subscription_status,
      subscriptions.current_period_end
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    LEFT JOIN subscriptions ON subscriptions.user_id = users.id
    WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2
    LIMIT 1
  `).bind(tokenHash, nowIso()).first();

  if (!row) {
    if (required) throw new HttpError(401, "Session expirée ou invalide.");
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    sessionId: row.session_id,
    plan: PLANS[row.plan] ? row.plan : "free",
    subscriptionStatus: row.subscription_status,
    currentPeriodEnd: row.current_period_end
  };
}

function activePlan(user) {
  if (!user) return PLANS.free;
  if (!["active", "trialing"].includes(user.subscriptionStatus)) return PLANS.free;
  return PLANS[user.plan] || PLANS.free;
}

async function createSession(db, userId) {
  const rawToken = randomToken(32);
  const tokenHash = await sha256(rawToken);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(crypto.randomUUID(), userId, tokenHash, expiresAt, createdAt).run();
  return { token: rawToken, expiresAt };
}

async function handleRegister(request, env, origin) {
  const db = requireDatabase(env);
  const body = await readJsonBody(request, 20_000);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const salt = encodeBase64Url(saltBytes);
  const passwordHash = await derivePasswordHash(password, saltBytes);
  const createdAt = nowIso();
  const userId = crypto.randomUUID();

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO users (id, email, password_hash, password_salt, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      `).bind(userId, email, passwordHash, salt, createdAt),
      db.prepare(`
        INSERT INTO subscriptions (user_id, plan, status, created_at, updated_at)
        VALUES (?1, 'free', 'active', ?2, ?2)
      `).bind(userId, createdAt)
    ]);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || error))) {
      throw new HttpError(409, "Un compte existe déjà avec cette adresse e-mail.");
    }
    throw error;
  }

  const session = await createSession(db, userId);
  return json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: userId, email, plan: "free" }
  }, 201, corsHeaders(origin));
}

async function handleLogin(request, env, origin) {
  const db = requireDatabase(env);
  const body = await readJsonBody(request, 20_000);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const user = await db.prepare(`
    SELECT id, email, password_hash, password_salt
    FROM users
    WHERE email = ?1 COLLATE NOCASE
    LIMIT 1
  `).bind(email).first();

  if (!user) throw new HttpError(401, "E-mail ou mot de passe incorrect.");
  const candidateHash = await derivePasswordHash(password, user.password_salt);
  if (!constantTimeEqual(candidateHash, user.password_hash)) {
    throw new HttpError(401, "E-mail ou mot de passe incorrect.");
  }

  const session = await createSession(db, user.id);
  const subscription = await db.prepare(`
    SELECT plan, status, current_period_end
    FROM subscriptions
    WHERE user_id = ?1
  `).bind(user.id).first();

  return json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      email: user.email,
      plan: PLANS[subscription?.plan] ? subscription.plan : "free",
      subscriptionStatus: subscription?.status || "active",
      currentPeriodEnd: subscription?.current_period_end || null
    }
  }, 200, corsHeaders(origin));
}

async function handleMe(request, env, origin) {
  const user = await getSessionUser(request, env, true);
  const plan = activePlan(user);
  const usage = await getUsage(env.DB, user.id);
  return json({
    user: {
      id: user.id,
      email: user.email,
      plan: plan.key,
      subscriptionStatus: user.subscriptionStatus,
      currentPeriodEnd: user.currentPeriodEnd
    },
    limits: plan,
    usage
  }, 200, corsHeaders(origin));
}

async function handleLogout(request, env, origin) {
  const user = await getSessionUser(request, env, true);
  await env.DB.prepare("DELETE FROM sessions WHERE id = ?1").bind(user.sessionId).run();
  return json({ success: true }, 200, corsHeaders(origin));
}

async function getUsage(db, userId) {
  const period = monthPeriod();
  const rows = await db.prepare(`
    SELECT event_type, COALESCE(SUM(units), 0) AS total
    FROM usage_events
    WHERE user_id = ?1 AND period = ?2
    GROUP BY event_type
  `).bind(userId, period).all();

  const usage = { searches: 0, audits: 0 };
  for (const row of rows.results || []) {
    if (row.event_type === "search") usage.searches = Number(row.total) || 0;
    if (row.event_type === "audit") usage.audits = Number(row.total) || 0;
  }
  return usage;
}

async function recordUsageEvent(db, user, eventType, eventId, units, limit) {
  const safeEventId = sanitizeText(eventId, 160);
  if (!safeEventId) throw new HttpError(400, "Identifiant d’utilisation manquant.");
  const id = `${user.id}:${eventType}:${safeEventId}`;
  const existing = await db.prepare("SELECT id FROM usage_events WHERE id = ?1").bind(id).first();
  if (existing) return;

  const usage = await getUsage(db, user.id);
  const current = eventType === "search" ? usage.searches : usage.audits;
  if (current + units > limit) {
    throw new HttpError(402, "Quota mensuel atteint. Passe à une offre supérieure pour continuer.");
  }

  await db.prepare(`
    INSERT INTO usage_events (id, user_id, event_type, period, units, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
  `).bind(id, user.id, eventType, monthPeriod(), units, nowIso()).run();
}

async function enforceProductUsage(request, env, route) {
  const user = await getSessionUser(request, env, true);
  const plan = activePlan(user);
  const payload = await request.clone().json().catch(() => ({}));

  if (route === "/api/enrich") {
    const totalBusinesses = Math.max(1, Number(payload.totalBusinesses || payload.businesses?.length || 1));
    if (totalBusinesses > plan.prospectsPerSearch) {
      throw new HttpError(402, `Ton offre autorise ${plan.prospectsPerSearch} prospects par recherche.`);
    }
    await recordUsageEvent(
      env.DB,
      user,
      "search",
      payload.searchRunId,
      1,
      plan.searchesPerMonth
    );
  }

  if (route === "/api/audit") {
    await recordUsageEvent(
      env.DB,
      user,
      "audit",
      payload.auditId || payload.url,
      1,
      plan.auditsPerMonth
    );
  }

  return user;
}

async function handleDataGet(request, env, origin) {
  const user = await getSessionUser(request, env, true);
  const row = await env.DB.prepare("SELECT payload, updated_at FROM user_data WHERE user_id = ?1")
    .bind(user.id)
    .first();
  return json({
    data: row?.payload ? JSON.parse(row.payload) : null,
    updatedAt: row?.updated_at || null
  }, 200, corsHeaders(origin));
}

async function handleDataPut(request, env, origin) {
  const user = await getSessionUser(request, env, true);
  const body = await readJsonBody(request, MAX_JSON_BYTES);
  const serialized = JSON.stringify(body.data ?? null);
  if (serialized.length > MAX_JSON_BYTES) throw new HttpError(413, "Données trop volumineuses.");
  const updatedAt = nowIso();

  await env.DB.prepare(`
    INSERT INTO user_data (user_id, payload, updated_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).bind(user.id, serialized, updatedAt).run();

  return json({ success: true, updatedAt }, 200, corsHeaders(origin));
}

function publicPlans(env) {
  return Object.values(PLANS).map((plan) => ({
    key: plan.key,
    label: plan.label,
    priceMonthly: plan.priceMonthly,
    searchesPerMonth: plan.searchesPerMonth,
    prospectsPerSearch: plan.prospectsPerSearch,
    auditsPerMonth: plan.auditsPerMonth,
    purchasable: plan.key === "solo"
      ? Boolean(env.STRIPE_PRICE_SOLO)
      : plan.key === "pro"
        ? Boolean(env.STRIPE_PRICE_PRO)
        : false
  }));
}

function handleConfig(env, origin) {
  const saasEnabled = String(env.SAAS_MODE || "").toLowerCase() === "true" && Boolean(env.DB);
  const billingEnabled = saasEnabled
    && Boolean(env.STRIPE_SECRET_KEY)
    && Boolean(env.STRIPE_PRICE_SOLO || env.STRIPE_PRICE_PRO)
    && Boolean(env.APP_URL);

  return json({
    saasEnabled,
    billingEnabled,
    plans: publicPlans(env)
  }, 200, corsHeaders(origin));
}

async function createStripeCheckout(request, env, origin) {
  const user = await getSessionUser(request, env, true);
  if (!env.STRIPE_SECRET_KEY || !env.APP_URL) {
    throw new HttpError(503, "Paiement Stripe non configuré.");
  }

  const body = await readJsonBody(request, 20_000);
  const requestedPlan = sanitizeText(body.plan, 20);
  const priceId = requestedPlan === "solo"
    ? env.STRIPE_PRICE_SOLO
    : requestedPlan === "pro"
      ? env.STRIPE_PRICE_PRO
      : null;
  if (!priceId) throw new HttpError(400, "Offre indisponible.");

  const appUrl = String(env.APP_URL).replace(/\/+$/, "");
  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    client_reference_id: user.id,
    customer_email: user.email,
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/?checkout=cancelled`,
    "metadata[user_id]": user.id,
    "metadata[plan]": requestedPlan,
    "subscription_data[metadata][user_id]": user.id,
    "subscription_data[metadata][plan]": requestedPlan,
    allow_promotion_codes: "true"
  });

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: params
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.url) {
    throw new HttpError(502, sanitizeText(payload?.error?.message || "Stripe est indisponible.", 300));
  }

  return json({ url: payload.url }, 200, corsHeaders(origin));
}

function parseStripeSignature(value) {
  const parts = String(value || "").split(",");
  const result = { timestamp: null, signatures: [] };
  for (const part of parts) {
    const [key, itemValue] = part.split("=", 2);
    if (key === "t") result.timestamp = Number(itemValue);
    if (key === "v1") result.signatures.push(itemValue);
  }
  return result;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeWebhook(rawBody, signatureHeader, secret) {
  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed.timestamp || !parsed.signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - parsed.timestamp) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parsed.timestamp}.${rawBody}`)
  );
  const expected = bytesToHex(new Uint8Array(signature));
  return parsed.signatures.some((candidate) => constantTimeEqual(candidate, expected));
}

async function upsertSubscription(db, values) {
  const updatedAt = nowIso();
  const existing = values.userId
    ? await db.prepare("SELECT user_id FROM subscriptions WHERE user_id = ?1").bind(values.userId).first()
    : null;
  let userId = existing?.user_id || values.userId || null;

  if (!userId && values.subscriptionId) {
    const row = await db.prepare("SELECT user_id FROM subscriptions WHERE stripe_subscription_id = ?1")
      .bind(values.subscriptionId)
      .first();
    userId = row?.user_id || null;
  }
  if (!userId && values.customerId) {
    const row = await db.prepare("SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?1")
      .bind(values.customerId)
      .first();
    userId = row?.user_id || null;
  }
  if (!userId) return;

  const plan = PLANS[values.plan] ? values.plan : "free";
  await db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, status, stripe_customer_id, stripe_subscription_id,
      current_period_end, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      status = excluded.status,
      stripe_customer_id = COALESCE(excluded.stripe_customer_id, subscriptions.stripe_customer_id),
      stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, subscriptions.stripe_subscription_id),
      current_period_end = excluded.current_period_end,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    plan,
    values.status || "active",
    values.customerId || null,
    values.subscriptionId || null,
    values.currentPeriodEnd || null,
    updatedAt
  ).run();
}

async function handleStripeEvent(event, env) {
  const object = event?.data?.object || {};

  if (event.type === "checkout.session.completed") {
    await upsertSubscription(env.DB, {
      userId: object.client_reference_id || object.metadata?.user_id,
      plan: object.metadata?.plan,
      status: "active",
      customerId: object.customer,
      subscriptionId: object.subscription,
      currentPeriodEnd: null
    });
  }

  if (["customer.subscription.created", "customer.subscription.updated"].includes(event.type)) {
    await upsertSubscription(env.DB, {
      userId: object.metadata?.user_id,
      plan: object.metadata?.plan,
      status: object.status,
      customerId: object.customer,
      subscriptionId: object.id,
      currentPeriodEnd: object.current_period_end
        ? new Date(object.current_period_end * 1000).toISOString()
        : null
    });
  }

  if (event.type === "customer.subscription.deleted") {
    await upsertSubscription(env.DB, {
      userId: object.metadata?.user_id,
      plan: "free",
      status: "cancelled",
      customerId: object.customer,
      subscriptionId: object.id,
      currentPeriodEnd: object.current_period_end
        ? new Date(object.current_period_end * 1000).toISOString()
        : null
    });
  }
}

async function handleStripeWebhook(request, env) {
  requireDatabase(env);
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "Webhook Stripe non configuré.");
  const rawBody = await request.text();
  const valid = await verifyStripeWebhook(
    rawBody,
    request.headers.get("Stripe-Signature"),
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) throw new HttpError(400, "Signature Stripe invalide.");

  const event = JSON.parse(rawBody);
  await handleStripeEvent(event, env);
  return json({ received: true });
}

function isSaasEnabled(env) {
  return String(env.SAAS_MODE || "").toLowerCase() === "true";
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") && !origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.headers.get("Origin") && !origin) {
      return json({ error: "Origine non autorisée." }, 403);
    }

    try {
      if (url.pathname === "/api/config" && request.method === "GET") {
        return handleConfig(env, origin);
      }

      if (url.pathname === "/api/stripe/webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }

      if (url.pathname === "/api/auth/register" && request.method === "POST") {
        return await handleRegister(request, env, origin);
      }
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        return await handleLogin(request, env, origin);
      }
      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        return await handleMe(request, env, origin);
      }
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return await handleLogout(request, env, origin);
      }
      if (url.pathname === "/api/data" && request.method === "GET") {
        return await handleDataGet(request, env, origin);
      }
      if (url.pathname === "/api/data" && request.method === "PUT") {
        return await handleDataPut(request, env, origin);
      }
      if (url.pathname === "/api/billing/checkout" && request.method === "POST") {
        return await createStripeCheckout(request, env, origin);
      }

      if (isSaasEnabled(env) && ["/api/enrich", "/api/audit"].includes(url.pathname)) {
        requireDatabase(env);
        await enforceProductUsage(request, env, url.pathname);
      }

      const response = await productWorker.fetch(request, env, ctx);
      return withCors(response, origin);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Erreur interne.";
      return json({ error: sanitizeText(message, 500) }, status, corsHeaders(origin));
    }
  }
};
