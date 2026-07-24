"use strict";

(function activateSignalLeadSaasClient() {
  if (window.__SIGNAL_LEAD_SAAS_CLIENT__) return;
  window.__SIGNAL_LEAD_SAAS_CLIENT__ = true;

  const TOKEN_KEY = "signalLead.auth.token";
  const originalFetch = window.fetch.bind(window);
  const authState = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    user: null,
    limits: null,
    usage: null,
    config: null,
    searchRunId: null,
    syncTimer: null,
    syncSuspended: false
  };

  window.SIGNAL_LEAD_AUTH = Object.freeze({
    getToken: () => authState.token,
    isAuthenticated: () => Boolean(authState.token),
    open: () => openAccountDialog()
  });

  function backendUrl(path) {
    const base = String(window.SIGNAL_LEAD_BACKEND?.baseUrl || "").replace(/\/+$/, "");
    return base ? `${base}${path}` : null;
  }

  function isBackendRequest(input) {
    const base = String(window.SIGNAL_LEAD_BACKEND?.baseUrl || "").replace(/\/+$/, "");
    if (!base) return false;
    const value = typeof input === "string" ? input : input?.url;
    return typeof value === "string" && value.startsWith(base);
  }

  function enrichRequestBody(url, options) {
    if (!options?.body || typeof options.body !== "string") return options;
    let payload;
    try {
      payload = JSON.parse(options.body);
    } catch {
      return options;
    }

    const pathname = new URL(url).pathname;
    if (pathname === "/api/enrich") {
      payload.searchRunId = authState.searchRunId || crypto.randomUUID();
      authState.searchRunId = payload.searchRunId;
      payload.totalBusinesses = Array.isArray(state?.items) ? state.items.length : payload.businesses?.length;
    }

    if (pathname === "/api/audit") {
      const identity = payload.business?.siret
        || payload.business?.siren
        || payload.business?.commercialName
        || payload.business?.name
        || "prospect";
      payload.auditId = `${identity}:${payload.url}`;
    }

    return { ...options, body: JSON.stringify(payload) };
  }

  window.fetch = function signalLeadAuthenticatedFetch(input, options = {}) {
    if (!isBackendRequest(input)) return originalFetch(input, options);

    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    if (authState.token) headers.set("Authorization", `Bearer ${authState.token}`);
    const enriched = enrichRequestBody(url, { ...options, headers });
    return originalFetch(input, enriched);
  };

  async function api(path, options = {}) {
    const url = backendUrl(path);
    if (!url) throw new Error("Backend non configuré.");
    const headers = new Headers(options.headers || {});
    headers.set("Accept", "application/json");
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (authState.token) headers.set("Authorization", `Bearer ${authState.token}`);

    const response = await originalFetch(url, { ...options, headers });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(payload?.error || `Erreur ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setToken(token) {
    authState.token = String(token || "");
    if (authState.token) localStorage.setItem(TOKEN_KEY, authState.token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function createElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function ensureAccountUi() {
    if (document.querySelector("#account-button")) return;

    const topbar = document.querySelector(".topbar");
    const newSearchButton = document.querySelector("#new-search");
    const actions = createElement("div", "account-actions");
    const accountButton = createElement("button", "button button-secondary", "Se connecter");
    accountButton.id = "account-button";
    accountButton.type = "button";
    accountButton.addEventListener("click", openAccountDialog);
    actions.append(accountButton);
    if (newSearchButton) actions.append(newSearchButton);
    topbar?.append(actions);

    const dialog = document.createElement("dialog");
    dialog.id = "account-dialog";
    dialog.className = "account-dialog";
    dialog.setAttribute("aria-labelledby", "account-title");
    dialog.innerHTML = `
      <div class="account-dialog-header">
        <div>
          <span class="account-kicker">Compte SignalLead</span>
          <h2 id="account-title">Accès et abonnement</h2>
        </div>
        <button class="icon-button" id="close-account-dialog" type="button" aria-label="Fermer">×</button>
      </div>
      <div class="account-dialog-body">
        <section id="account-auth-section">
          <div class="account-tabs" role="tablist" aria-label="Authentification">
            <button type="button" class="active" data-auth-tab="login">Connexion</button>
            <button type="button" data-auth-tab="register">Créer un compte</button>
          </div>
          <form id="account-form" class="account-form">
            <label>Adresse e-mail<input id="account-email" type="email" autocomplete="email" required></label>
            <label>Mot de passe<input id="account-password" type="password" minlength="12" autocomplete="current-password" required></label>
            <p class="account-help" id="account-help">Connecte-toi pour retrouver tes prospects sur tous tes appareils.</p>
            <button class="button button-primary" id="account-submit" type="submit">Se connecter</button>
          </form>
        </section>
        <section id="account-profile-section" hidden>
          <div class="account-profile-card">
            <div><span>Compte</span><strong id="account-email-value">—</strong></div>
            <div><span>Offre</span><strong id="account-plan-value">—</strong></div>
            <button class="button button-secondary" id="account-logout" type="button">Se déconnecter</button>
          </div>
          <div class="account-usage" id="account-usage"></div>
        </section>
        <section class="account-plans" id="account-plans" aria-labelledby="plans-title">
          <div class="account-section-heading">
            <span>Abonnements</span>
            <h3 id="plans-title">Choisis selon ton volume</h3>
          </div>
          <div class="plan-grid" id="plan-grid"></div>
        </section>
      </div>
    `;
    document.body.append(dialog);

    dialog.querySelector("#close-account-dialog").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    const tabs = [...dialog.querySelectorAll("[data-auth-tab]")];
    for (const tab of tabs) {
      tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab));
    }
    dialog.querySelector("#account-form").addEventListener("submit", handleAuthSubmit);
    dialog.querySelector("#account-logout").addEventListener("click", logout);
  }

  function setAuthMode(mode) {
    const dialog = document.querySelector("#account-dialog");
    if (!dialog) return;
    dialog.dataset.authMode = mode;
    for (const tab of dialog.querySelectorAll("[data-auth-tab]")) {
      tab.classList.toggle("active", tab.dataset.authTab === mode);
    }
    const password = dialog.querySelector("#account-password");
    const submit = dialog.querySelector("#account-submit");
    const help = dialog.querySelector("#account-help");
    if (mode === "register") {
      password.autocomplete = "new-password";
      submit.textContent = "Créer mon compte";
      help.textContent = "Utilise au moins 12 caractères. Tes prospects seront sauvegardés dans ton compte.";
    } else {
      password.autocomplete = "current-password";
      submit.textContent = "Se connecter";
      help.textContent = "Connecte-toi pour retrouver tes prospects sur tous tes appareils.";
    }
  }

  function openAccountDialog() {
    ensureAccountUi();
    const dialog = document.querySelector("#account-dialog");
    if (dialog && !dialog.open) dialog.showModal();
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    const dialog = document.querySelector("#account-dialog");
    const mode = dialog?.dataset.authMode || "login";
    const email = dialog.querySelector("#account-email").value.trim();
    const password = dialog.querySelector("#account-password").value;
    const submit = dialog.querySelector("#account-submit");
    submit.disabled = true;

    try {
      const payload = await api(`/api/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      setToken(payload.token);
      await refreshAccount();
      await synchronizeAfterLogin();
      showNotice(mode === "register" ? "Compte créé." : "Connexion réussie.", "success");
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      submit.disabled = false;
    }
  }

  async function logout() {
    try {
      if (authState.token) await api("/api/auth/logout", { method: "POST" });
    } catch {
      // The local session must still be cleared.
    }
    setToken("");
    authState.user = null;
    authState.limits = null;
    authState.usage = null;
    updateAccountUi();
    showNotice("Déconnexion effectuée.", "info");
  }

  function updateAccountUi() {
    ensureAccountUi();
    const button = document.querySelector("#account-button");
    const authSection = document.querySelector("#account-auth-section");
    const profileSection = document.querySelector("#account-profile-section");

    if (authState.user) {
      button.textContent = `${authState.user.plan.toUpperCase()} · ${authState.user.email}`;
      authSection.hidden = true;
      profileSection.hidden = false;
      document.querySelector("#account-email-value").textContent = authState.user.email;
      document.querySelector("#account-plan-value").textContent = authState.user.plan.toUpperCase();
      renderUsage();
    } else {
      button.textContent = "Se connecter";
      authSection.hidden = false;
      profileSection.hidden = true;
    }
    applyPlanLimits();
    renderPlans();
  }

  function renderUsage() {
    const container = document.querySelector("#account-usage");
    if (!container || !authState.limits || !authState.usage) return;
    container.replaceChildren();

    const values = [
      ["Recherches", authState.usage.searches, authState.limits.searchesPerMonth],
      ["Audits", authState.usage.audits, authState.limits.auditsPerMonth]
    ];
    for (const [label, used, limit] of values) {
      const item = createElement("div", "usage-item");
      item.append(
        createElement("span", "", label),
        createElement("strong", "", `${used} / ${limit}`)
      );
      const progress = createElement("div", "usage-progress");
      const bar = createElement("span", "");
      bar.style.width = `${Math.min(100, Math.round((used / Math.max(1, limit)) * 100))}%`;
      progress.append(bar);
      item.append(progress);
      container.append(item);
    }
  }

  function renderPlans() {
    const grid = document.querySelector("#plan-grid");
    if (!grid || !authState.config) return;
    grid.replaceChildren();

    for (const plan of authState.config.plans || []) {
      const card = createElement("article", `plan-card${authState.user?.plan === plan.key ? " current" : ""}`);
      card.append(
        createElement("span", "plan-name", plan.label),
        createElement("strong", "plan-price", plan.priceMonthly ? `${plan.priceMonthly} € / mois` : "Gratuit"),
        createElement("p", "plan-description", `${plan.prospectsPerSearch} prospects par recherche · ${plan.searchesPerMonth} recherches par mois`)
      );

      if (plan.key === authState.user?.plan) {
        card.append(createElement("span", "plan-current", "Offre actuelle"));
      } else if (plan.purchasable) {
        const button = createElement("button", "button button-primary", `Choisir ${plan.label}`);
        button.type = "button";
        button.disabled = !authState.user;
        button.addEventListener("click", () => startCheckout(plan.key));
        card.append(button);
      }
      grid.append(card);
    }
  }

  async function startCheckout(plan) {
    if (!authState.user) {
      setAuthMode("register");
      openAccountDialog();
      return;
    }

    try {
      const payload = await api("/api/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ plan })
      });
      window.location.assign(payload.url);
    } catch (error) {
      showNotice(error.message, "error");
    }
  }

  function applyPlanLimits() {
    const limit = authState.limits?.prospectsPerSearch || 10;
    const select = document.querySelector("#result-limit");
    if (!select || !authState.config?.saasEnabled) return;
    for (const option of select.options) {
      option.disabled = Number(option.value) > limit;
    }
    if (Number(select.value) > limit) select.value = String(limit);
  }

  async function refreshAccount() {
    if (!authState.token) {
      updateAccountUi();
      return;
    }

    try {
      const payload = await api("/api/auth/me");
      authState.user = payload.user;
      authState.limits = payload.limits;
      authState.usage = payload.usage;
    } catch (error) {
      if (error.status === 401) setToken("");
      authState.user = null;
      authState.limits = null;
      authState.usage = null;
    }
    updateAccountUi();
  }

  function getLocalSnapshot() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "null");
      return parsed && Array.isArray(parsed.items) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function synchronizeAfterLogin() {
    if (!authState.user) return;
    const remote = await api("/api/data");
    const local = getLocalSnapshot();
    const remoteData = remote.data;
    const remoteDate = Date.parse(remote.updatedAt || remoteData?.savedAt || 0);
    const localDate = Date.parse(local?.savedAt || 0);

    if (remoteData?.version === CONFIG.storageVersion && Array.isArray(remoteData.items) && remoteDate > localDate) {
      authState.syncSuspended = true;
      state.items = remoteData.items.filter(isValidItem).slice(0, CONFIG.maxResults);
      for (const item of state.items) updatePriority(item);
      persistItems();
      render();
      authState.syncSuspended = false;
      return;
    }

    if (local) await uploadSnapshot(local);
  }

  async function uploadSnapshot(snapshot = getLocalSnapshot()) {
    if (!authState.user || !snapshot) return;
    await api("/api/data", {
      method: "PUT",
      body: JSON.stringify({ data: snapshot })
    });
  }

  function scheduleCloudSync() {
    if (!authState.user || authState.syncSuspended) return;
    clearTimeout(authState.syncTimer);
    authState.syncTimer = setTimeout(() => {
      uploadSnapshot().catch(() => undefined);
    }, 900);
  }

  function wrapPersistence() {
    if (typeof persistItems !== "function" || persistItems.__saasWrapped) return;
    const basePersistItems = persistItems;
    const wrapped = function persistItemsWithCloudSync() {
      basePersistItems();
      scheduleCloudSync();
    };
    wrapped.__saasWrapped = true;
    persistItems = wrapped;
  }

  function protectSearchForm() {
    const form = document.querySelector("#search-form");
    if (!form || form.dataset.saasProtected === "true") return;
    form.dataset.saasProtected = "true";
    form.addEventListener("submit", (event) => {
      if (!authState.config?.saasEnabled) return;
      if (!authState.user) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openAccountDialog();
        showNotice("Connecte-toi pour lancer une recherche.", "info");
        return;
      }
      authState.searchRunId = crypto.randomUUID();
    }, true);
  }

  async function initialize() {
    const configUrl = backendUrl("/api/config");
    if (!configUrl) return;

    try {
      authState.config = await api("/api/config");
    } catch {
      return;
    }

    if (!authState.config.saasEnabled) return;
    ensureAccountUi();
    wrapPersistence();
    protectSearchForm();
    await refreshAccount();
    if (authState.user) await synchronizeAfterLogin().catch(() => undefined);

    const checkout = new URLSearchParams(window.location.search).get("checkout");
    if (checkout === "success") {
      showNotice("Paiement confirmé. Ton offre sera mise à jour dans quelques secondes.", "success");
      window.setTimeout(() => refreshAccount(), 2500);
    } else if (checkout === "cancelled") {
      showNotice("Paiement annulé.", "info");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
