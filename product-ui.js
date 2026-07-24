"use strict";

(function activateSignalLeadSimpleUi() {
  if (window.__SIGNAL_LEAD_SIMPLE_UI__) return;
  window.__SIGNAL_LEAD_SIMPLE_UI__ = true;

  if (
    typeof render !== "function"
    || typeof syncDialog !== "function"
    || typeof getVisibleItems !== "function"
  ) {
    window.__SIGNAL_LEAD_SIMPLE_UI__ = false;
    return;
  }

  const baseRender = render;
  const baseSyncDialog = syncDialog;

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function safeHostname(value) {
    if (!value) return null;
    try {
      return new URL(value).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function simplifyPageChrome() {
    document.querySelector(".intro")?.remove();

    const topbarEyebrow = document.querySelector(".topbar .eyebrow");
    if (topbarEyebrow) topbarEyebrow.remove();

    const topbarTitle = document.querySelector(".topbar h1");
    if (topbarTitle) topbarTitle.textContent = "SignalLead";

    const navigationItems = document.querySelectorAll(".side-nav a, .side-nav button");
    if (navigationItems[0]) {
      navigationItems[0].textContent = "Recherche";
      navigationItems[0].setAttribute("href", "#search");
    }
    if (navigationItems[1]) navigationItems[1].textContent = "Nouvelle recherche";
    if (navigationItems[2]) navigationItems[2].textContent = "Prospects";
    if (navigationItems[3]) navigationItems[3].textContent = "Exporter";

    const searchHeading = document.querySelector("#search .section-heading");
    searchHeading?.querySelector(".eyebrow")?.remove();
    searchHeading?.querySelector("p:not(.eyebrow)")?.remove();
    searchHeading?.querySelector(".source-badge")?.remove();

    const searchTitle = document.querySelector("#search-title");
    if (searchTitle) searchTitle.textContent = "Trouver des prospects";

    const labels = {
      service: "Votre offre",
      category: "Cible",
      location: "Zone",
      radius: "Rayon",
      "result-limit": "Nombre"
    };

    for (const [inputId, label] of Object.entries(labels)) {
      const node = document.querySelector(`label[for="${inputId}"]`);
      if (node) node.textContent = label;
    }

    if (dom.launch) dom.launch.textContent = state.isLoading ? "Recherche…" : "Rechercher";

    const resultHeading = document.querySelector("#prospects .section-heading");
    resultHeading?.querySelector(".eyebrow")?.remove();

    const resultTitle = document.querySelector("#prospects-title");
    if (resultTitle) resultTitle.textContent = "Prospects";

    const summaryLabels = [
      ["#summary-total", "Trouvés"],
      ["#summary-audited", "Analysés"],
      ["#summary-high", "À contacter"],
      ["#summary-pending", "À qualifier"]
    ];

    for (const [selector, label] of summaryLabels) {
      const value = document.querySelector(selector);
      const card = value?.closest(".summary-card");
      const text = card?.querySelector("span");
      if (text) text.textContent = label;
      card?.querySelector("small")?.remove();
    }

    const sourceNote = document.querySelector(".source-note p");
    if (sourceNote) sourceNote.textContent = "Données publiques françaises et OpenStreetMap.";
  }

  function setFilterLabels() {
    const select = document.querySelector("#qualification-filter");
    if (!select) return;

    const labels = {
      all: "Tous",
      contact_now: "À contacter",
      secondary: "À proposer",
      verify: "À qualifier",
      equipped: "Peu prioritaires",
      low_fit: "À écarter"
    };

    for (const option of select.options) {
      if (labels[option.value]) option.textContent = labels[option.value];
    }

    const sort = document.querySelector("#sort");
    if (sort?.options[0]) sort.options[0].textContent = "Meilleures opportunités";
  }

  function getPresentation(item) {
    const intelligence = item.commercialIntelligence;
    const websiteKnown = Boolean(item.website || item.noSiteConfirmed);
    const audited = Boolean(item.audit || item.noSiteConfirmed);

    if (!websiteKnown) {
      return {
        label: "À qualifier",
        tone: "warning",
        title: "Site à identifier",
        reason: "Valide le site officiel avant de décider.",
        recommendation: "Identifier le site",
        budget: null,
        action: "find-site",
        actionLabel: "Identifier"
      };
    }

    if (!audited) {
      return {
        label: "À analyser",
        tone: "warning",
        title: "Site à analyser",
        reason: "Mesure le besoin avant de contacter l’entreprise.",
        recommendation: "Lancer l’analyse",
        budget: null,
        action: "audit-site",
        actionLabel: "Analyser"
      };
    }

    if (intelligence.verdict === "contact_now") {
      return {
        label: "À contacter",
        tone: "danger",
        title: intelligence.primarySignal,
        reason: "Le besoin et le potentiel commercial sont confirmés.",
        recommendation: intelligence.primaryOffer,
        budget: intelligence.priceRange,
        action: "contact",
        actionLabel: "Préparer le contact"
      };
    }

    if (intelligence.verdict === "secondary") {
      return {
        label: "À proposer",
        tone: "info",
        title: intelligence.primarySignal,
        reason: "Une prestation ciblée peut être pertinente.",
        recommendation: intelligence.primaryOffer,
        budget: intelligence.priceRange,
        action: "contact",
        actionLabel: "Préparer une offre"
      };
    }

    if (intelligence.verdict === "equipped") {
      return {
        label: "Peu prioritaire",
        tone: "success",
        title: "Site déjà satisfaisant",
        reason: "Évite une refonte sans nouveau signal commercial.",
        recommendation: "Maintenance ponctuelle",
        budget: intelligence.priceRange,
        action: "details",
        actionLabel: "Voir l’analyse"
      };
    }

    if (intelligence.verdict === "low_fit") {
      return {
        label: "À écarter",
        tone: "muted",
        title: "Prospect peu adapté",
        reason: "Le potentiel estimé ne justifie pas d’action immédiate.",
        recommendation: "Aucune action",
        budget: null,
        action: "ignore",
        actionLabel: "Ignorer"
      };
    }

    return {
      label: "À vérifier",
      tone: "warning",
      title: intelligence.primarySignal || "Données insuffisantes",
      reason: "Vérifie les informations avant de prospecter.",
      recommendation: "Compléter la qualification",
      budget: null,
      action: "details",
      actionLabel: "Voir les preuves"
    };
  }

  function renderScoreCell(cell, item, presentation) {
    cell.replaceChildren();
    cell.className = "sl-priority-cell";

    const line = element("div", "sl-priority-line");
    line.append(
      element("strong", "sl-priority-score", `${item.commercialIntelligence.opportunityScore}`),
      element("span", `sl-status sl-status-${presentation.tone}`, presentation.label)
    );
    cell.append(line);
  }

  function renderRecommendationCell(cell, item, presentation) {
    cell.replaceChildren();
    cell.className = "sl-diagnostic-cell";

    const host = safeHostname(item.website);
    const detail = host
      ? `${presentation.recommendation} · ${host}`
      : presentation.recommendation;

    cell.append(
      element("strong", "sl-diagnostic-title", presentation.title),
      element("span", "sl-diagnostic-meta", detail)
    );
  }

  function enhanceTable() {
    const table = document.querySelector(".prospect-table");
    if (!table) return;

    table.className = "prospect-table sl-prospect-table";
    const headers = [...table.querySelectorAll("thead th")];

    if (headers.length >= 6) {
      headers[0].textContent = "Prospect";
      headers[1].textContent = "Score";
      headers[2].textContent = "Prochaine action";
      headers[3].classList.add("sl-hidden-column");
      headers[4].classList.add("sl-hidden-column");
      headers[5].innerHTML = '<span class="visually-hidden">Ouvrir</span>';
    }

    const visibleItems = getVisibleItems();
    const rows = [...dom.results.querySelectorAll("tr")];

    rows.forEach((row, index) => {
      const item = visibleItems[index];
      const cells = [...row.querySelectorAll("td")];
      if (!item?.commercialIntelligence || cells.length < 6) return;

      const presentation = getPresentation(item);
      row.className = `sl-prospect-row sl-tone-${presentation.tone}`;
      row.dataset.prospectId = item.id;
      row.tabIndex = 0;

      renderScoreCell(cells[1], item, presentation);
      renderRecommendationCell(cells[2], item, presentation);
      cells[3].classList.add("sl-hidden-column");
      cells[4].classList.add("sl-hidden-column");
      cells[5].className = "row-actions sl-row-actions";

      const button = cells[5].querySelector("button");
      if (!button) return;

      button.textContent = "Voir";
      button.className = "button button-secondary sl-open-button";
      button.setAttribute("aria-label", `Ouvrir ${item.commercialName || item.name}`);

      if (row.dataset.bound !== "true") {
        row.dataset.bound = "true";
        row.addEventListener("click", (event) => {
          if (event.target.closest("button, a, input, select, textarea")) return;
          button.click();
        });
        row.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          button.click();
        });
      }
    });
  }

  function ensureDecisionSection() {
    const body = document.querySelector("#prospect-dialog .dialog-body");
    if (!body) return null;

    let section = document.querySelector("#commercial-intelligence-section");
    if (!section) {
      section = document.createElement("section");
      section.id = "commercial-intelligence-section";
      body.prepend(section);
    }
    return section;
  }

  function createProofList(values) {
    const list = element("ul", "sl-proof-list");
    const entries = values?.length ? values.slice(0, 4) : ["Vérification complémentaire nécessaire"];
    for (const value of entries) list.append(element("li", "", value));
    return list;
  }

  function runPrimaryAction(action) {
    if (action === "find-site" || action === "audit-site") {
      const workflow = document.querySelector(".sl-site-workflow");
      if (workflow) workflow.open = true;
      const target = action === "find-site" ? "#find-site" : "#audit-site";
      window.setTimeout(() => document.querySelector(target)?.click(), 150);
      return;
    }

    if (action === "contact") {
      const workflow = document.querySelector(".sl-contact-workflow");
      if (workflow) workflow.open = true;
      window.setTimeout(() => document.querySelector("#contact-message")?.focus(), 150);
      return;
    }

    if (action === "ignore") {
      const status = document.querySelector("#prospect-status");
      if (status) {
        status.value = "ignored";
        status.dispatchEvent(new Event("change", { bubbles: true }));
      }
      document.querySelector("#save-prospect")?.click();
      return;
    }

    const proofs = document.querySelector(".sl-proof-details");
    if (proofs) proofs.open = true;
  }

  function rebuildDecisionSection(item) {
    const section = ensureDecisionSection();
    if (!section) return;

    const intelligence = item.commercialIntelligence;
    const presentation = getPresentation(item);

    section.className = `dialog-section sl-decision-section sl-tone-${presentation.tone}`;
    section.replaceChildren();

    const main = element("div", "sl-decision-main");
    const copy = element("div", "sl-decision-copy");
    const status = element("div", "sl-decision-status");
    status.append(
      element("span", `sl-status sl-status-${presentation.tone}`, presentation.label),
      element("span", "sl-decision-confidence", `Confiance ${intelligence.confidence}/100`)
    );

    copy.append(
      status,
      element("h3", "sl-decision-title", presentation.title),
      element("p", "sl-decision-description", presentation.reason)
    );

    const score = element("div", "sl-decision-score");
    score.append(
      element("strong", "", String(intelligence.opportunityScore)),
      element("span", "", "/100")
    );
    main.append(copy, score);

    const actionBar = element("div", "sl-action-bar");
    const actionCopy = element("div", "sl-action-copy");
    actionCopy.append(
      element("span", "sl-action-label", "Action recommandée"),
      element("strong", "sl-action-title", presentation.recommendation)
    );
    if (presentation.budget) {
      actionCopy.append(element("small", "sl-action-budget", presentation.budget));
    }

    const actionButton = element("button", "button button-primary sl-primary-action", presentation.actionLabel);
    actionButton.type = "button";
    actionButton.addEventListener("click", () => runPrimaryAction(presentation.action));
    actionBar.append(actionCopy, actionButton);

    const proofs = document.createElement("details");
    proofs.className = "sl-proof-details";
    proofs.append(element("summary", "", "Voir les preuves"));
    const proofBody = element("div", "sl-proof-body");
    proofBody.append(createProofList(intelligence.evidence));
    proofs.append(proofBody);

    section.append(main, actionBar, proofs);
  }

  function createWorkflow(section, className, title, nodes) {
    const existing = section.querySelector(`.${className}`);
    if (existing) return existing;

    const details = document.createElement("details");
    details.className = `sl-workflow ${className}`;

    const summary = element("summary", "sl-workflow-summary");
    summary.append(
      element("span", "sl-workflow-title", title),
      element("span", "sl-workflow-caption", "")
    );

    details.append(summary, ...nodes.filter(Boolean));
    section.append(details);
    return details;
  }

  function prepareSiteSection(item) {
    const section = document.querySelector(".site-section");
    if (!section) return;

    section.className = "dialog-section sl-workflow-section";
    section.querySelector(":scope > .section-heading")?.remove();
    section.querySelector(":scope > .site-guidance")?.remove();

    const workflow = createWorkflow(section, "sl-site-workflow", "Site internet", [
      section.querySelector(":scope > .site-toolbar"),
      section.querySelector(":scope > .confirmation-control"),
      section.querySelector(":scope > .site-audit-layout"),
      section.querySelector(":scope > .manual-review")
    ]);

    const caption = workflow.querySelector(".sl-workflow-caption");
    if (!item.website && !item.noSiteConfirmed) caption.textContent = "À identifier";
    else if (item.website && !item.audit) caption.textContent = "À analyser";
    else caption.textContent = "Analysé";

    workflow.open = !item.website || !item.audit;

    const findButton = document.querySelector("#find-site");
    if (findButton) findButton.textContent = "Rechercher";
    const saveButton = document.querySelector("#save-site");
    if (saveButton) saveButton.textContent = "Valider";

    const auditLayout = document.querySelector(".site-audit-layout");
    if (auditLayout) auditLayout.hidden = !item.website;
    const manualReview = document.querySelector(".manual-review");
    if (manualReview) manualReview.hidden = !item.audit;
  }

  function prepareContactSection(item) {
    const section = document.querySelector("#contact-title")?.closest(".dialog-section")
      || document.querySelector(".sl-contact-workflow")?.closest(".dialog-section");
    if (!section) return;

    section.className = "dialog-section sl-workflow-section";
    let workflow = section.querySelector(".sl-contact-workflow");

    if (!workflow) {
      const status = section.querySelector("#prospect-status");
      const statusField = element("label", "sl-status-field");
      statusField.append(element("span", "", "Statut"));
      if (status) statusField.append(status);

      workflow = createWorkflow(section, "sl-contact-workflow", "Contact", [
        statusField,
        section.querySelector('label[for="contact-message"]'),
        section.querySelector("#contact-message"),
        section.querySelector(".dialog-actions")
      ]);
      section.querySelector(":scope > .section-heading")?.remove();
    }

    const ready = ["contact_now", "secondary"].includes(item.commercialIntelligence.verdict);
    workflow.querySelector(".sl-workflow-caption").textContent = ready ? "Message prêt" : "Après qualification";
    workflow.open = ready;
    if (dom.contactMessage) dom.contactMessage.rows = 5;

    const copyButton = document.querySelector("#copy-message");
    if (copyButton) copyButton.textContent = "Copier";
    const saveButton = document.querySelector("#save-prospect");
    if (saveButton) saveButton.textContent = "Enregistrer";
  }

  function prepareBusinessSection(item) {
    const section = document.querySelector("#business-title")?.closest(".dialog-section")
      || document.querySelector(".sl-business-workflow")?.closest(".dialog-section");
    if (!section) return;

    section.className = "dialog-section sl-workflow-section";
    const workflow = createWorkflow(section, "sl-business-workflow", "Entreprise", [
      section.querySelector("#dialog-metrics"),
      section.querySelector("#dialog-business-evidence")
    ]);

    section.querySelector(":scope > .section-heading")?.remove();
    workflow.querySelector(".sl-workflow-caption").textContent = `Potentiel ${item.businessScore ?? 0}/100`;
    workflow.open = false;
  }

  function orderDialogSections() {
    const body = document.querySelector("#prospect-dialog .dialog-body");
    const decision = document.querySelector("#commercial-intelligence-section");
    const site = document.querySelector(".sl-site-workflow")?.closest(".dialog-section");
    const contact = document.querySelector(".sl-contact-workflow")?.closest(".dialog-section");
    const business = document.querySelector(".sl-business-workflow")?.closest(".dialog-section");

    if (!body) return;
    for (const section of [decision, site, contact, business]) {
      if (section) body.append(section);
    }
  }

  function enhanceDialog() {
    const item = selectedProspect();
    const dialog = document.querySelector("#prospect-dialog");
    if (!item?.commercialIntelligence || !dialog) return;

    dialog.classList.add("sl-prospect-dialog");
    if (dom.dialogSegment) dom.dialogSegment.hidden = true;

    rebuildDecisionSection(item);
    prepareSiteSection(item);
    prepareContactSection(item);
    prepareBusinessSection(item);
    orderDialogSections();
  }

  render = function renderSignalLeadSimpleUi() {
    baseRender();
    simplifyPageChrome();
    setFilterLabels();
    enhanceTable();
  };

  syncDialog = function syncSignalLeadSimpleDialog() {
    baseSyncDialog();
    enhanceDialog();
  };

  render();
})();
