"use strict";

(function activateSignalLeadProductUi() {
  if (
    typeof render !== "function"
    || typeof syncDialog !== "function"
    || typeof getVisibleItems !== "function"
  ) {
    return;
  }

  const ORIGINAL_RENDER = render;
  const ORIGINAL_SYNC_DIALOG = syncDialog;

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

  function hasMeaningfulIssue(item, intelligence) {
    return Boolean(
      item.audit
      && intelligence.signals?.some((signal) => !/globalement satisfaisant/i.test(signal))
    );
  }

  function getPresentation(item) {
    const intelligence = item.commercialIntelligence;
    const websiteKnown = Boolean(item.website || item.noSiteConfirmed);
    const audited = Boolean(item.audit || item.noSiteConfirmed);
    const hasIssue = hasMeaningfulIssue(item, intelligence);

    if (!websiteKnown) {
      return {
        label: "À qualifier",
        tone: "warning",
        title: "Identifier le site avant de prospecter",
        description: "Le potentiel de l’entreprise est intéressant, mais son besoin numérique ne peut pas être confirmé tant que le site officiel reste inconnu.",
        diagnostic: "Site officiel non confirmé",
        recommendation: "Aucune offre recommandée avant validation",
        budget: "Après validation",
        action: "find-site",
        actionLabel: "Identifier le site"
      };
    }

    if (!audited) {
      return {
        label: "À analyser",
        tone: "warning",
        title: "Analyser le site avant de contacter",
        description: "Le site officiel est identifié. L’analyse doit maintenant confirmer qu’un besoin réel existe avant toute prise de contact.",
        diagnostic: "Site identifié, besoin non mesuré",
        recommendation: "Diagnostic en attente",
        budget: "Après analyse",
        action: "audit-site",
        actionLabel: "Analyser le site"
      };
    }

    if (intelligence.verdict === "contact_now") {
      return {
        label: "À contacter",
        tone: "danger",
        title: "Prospect prioritaire",
        description: "La capacité d’achat et le besoin numérique sont suffisamment confirmés pour préparer une prise de contact personnalisée.",
        diagnostic: intelligence.primarySignal,
        recommendation: intelligence.primaryOffer,
        budget: intelligence.priceRange,
        action: "contact",
        actionLabel: "Préparer le contact"
      };
    }

    if (intelligence.verdict === "secondary") {
      return {
        label: "Opportunité ciblée",
        tone: "info",
        title: "Une prestation ciblée peut être proposée",
        description: "Une refonte complète n’est pas forcément justifiée, mais un problème précis peut faire l’objet d’une offre limitée.",
        diagnostic: intelligence.primarySignal,
        recommendation: intelligence.primaryOffer,
        budget: intelligence.priceRange,
        action: "contact",
        actionLabel: "Préparer une approche ciblée"
      };
    }

    if (intelligence.verdict === "equipped" && hasIssue) {
      return {
        label: "Optimisation ciblée",
        tone: "info",
        title: "Le site est correct, avec un axe d’amélioration",
        description: "La refonte complète est peu pertinente. Une prestation courte et précisément cadrée reste toutefois commercialisable.",
        diagnostic: intelligence.primarySignal,
        recommendation: intelligence.primaryOffer,
        budget: intelligence.priceRange,
        action: "details",
        actionLabel: "Voir les preuves"
      };
    }

    if (intelligence.verdict === "equipped") {
      return {
        label: "Déjà bien équipé",
        tone: "success",
        title: "Aucun besoin prioritaire détecté",
        description: "Le site paraît suffisamment solide. Ce prospect ne doit pas être ciblé pour une refonte sans nouveau signal commercial.",
        diagnostic: "Site globalement satisfaisant",
        recommendation: "Maintenance ou audit ponctuel uniquement",
        budget: "Faible priorité",
        action: "details",
        actionLabel: "Consulter l’analyse"
      };
    }

    if (intelligence.verdict === "low_fit") {
      return {
        label: "À écarter",
        tone: "muted",
        title: "Prospect peu adapté à l’offre",
        description: "Le niveau de besoin ou la capacité commerciale estimée ne justifie pas d’y consacrer du temps maintenant.",
        diagnostic: intelligence.primarySignal || "Adéquation insuffisante",
        recommendation: "Aucune action commerciale immédiate",
        budget: "Non prioritaire",
        action: "ignore",
        actionLabel: "Classer comme ignoré"
      };
    }

    return {
      label: "À vérifier",
      tone: "warning",
      title: "Vérification complémentaire nécessaire",
      description: "Les données disponibles ne suffisent pas encore pour prendre une décision commerciale fiable.",
      diagnostic: intelligence.primarySignal,
      recommendation: "À définir après vérification",
      budget: "Après validation",
      action: "details",
      actionLabel: "Voir les preuves"
    };
  }

  function setFilterLabels() {
    const select = document.querySelector("#qualification-filter");
    if (!select) return;
    const labels = {
      all: "Tous les prospects",
      contact_now: "À contacter",
      secondary: "Opportunités ciblées",
      verify: "À qualifier",
      equipped: "Optimisation légère ou équipé",
      low_fit: "À écarter"
    };
    [...select.options].forEach((option) => {
      if (labels[option.value]) option.textContent = labels[option.value];
    });
  }

  function renderPriorityCell(cell, item, presentation) {
    cell.replaceChildren();
    cell.className = "sl-priority-cell";

    const top = element("div", "sl-priority-line");
    top.append(
      element("strong", "sl-priority-score", `${item.commercialIntelligence.opportunityScore}/100`),
      element("span", `sl-status sl-status-${presentation.tone}`, presentation.label)
    );

    cell.append(
      top,
      element("span", "sl-confidence", `Fiabilité ${item.commercialIntelligence.confidence}/100`)
    );
  }

  function renderDiagnosticCell(cell, item, presentation) {
    cell.replaceChildren();
    cell.className = "sl-diagnostic-cell";
    const host = safeHostname(item.website);
    const meta = host
      ? `${host} · ${presentation.recommendation}`
      : presentation.recommendation;

    cell.append(
      element("strong", "sl-diagnostic-title", presentation.diagnostic),
      element("span", "sl-diagnostic-meta", meta)
    );
  }

  function enhanceTable() {
    const table = document.querySelector(".prospect-table");
    if (!table) return;
    table.className = "prospect-table sl-prospect-table";

    const headers = [...table.querySelectorAll("thead th")];
    if (headers.length >= 6) {
      headers[0].textContent = "Entreprise";
      headers[1].textContent = "Priorité";
      headers[2].textContent = "Diagnostic";
      headers[3].classList.add("sl-hidden-column");
      headers[4].classList.add("sl-hidden-column");
      headers[5].innerHTML = '<span class="visually-hidden">Actions</span>';
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
      cells[0].className = "company-cell";
      renderPriorityCell(cells[1], item, presentation);
      renderDiagnosticCell(cells[2], item, presentation);
      cells[3].classList.add("sl-hidden-column");
      cells[4].classList.add("sl-hidden-column");
      cells[5].className = "row-actions sl-row-actions";

      const button = cells[5].querySelector("button");
      if (!button) return;
      button.textContent = presentation.action === "find-site" ? "Qualifier" : "Ouvrir";
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

  function createFact(label, value, caption) {
    const article = element("article", "sl-fact");
    article.append(
      element("span", "sl-fact-label", label),
      element("strong", "sl-fact-value", value),
      element("small", "sl-fact-caption", caption)
    );
    return article;
  }

  function createList(values, fallback) {
    const list = element("ul", "sl-proof-list");
    const entries = values?.length ? values : [fallback];
    entries.slice(0, 5).forEach((value) => list.append(element("li", "", value)));
    return list;
  }

  function buildBrief(item, presentation) {
    const intelligence = item.commercialIntelligence;
    const lines = [
      item.commercialName || item.name,
      `Décision : ${presentation.label}`,
      `Priorité : ${intelligence.opportunityScore}/100`,
      `Diagnostic : ${presentation.diagnostic}`,
      `Prestation : ${presentation.recommendation}`,
      `Budget indicatif : ${presentation.budget}`,
      ""
    ];

    if (intelligence.evidence?.length) {
      lines.push("Éléments vérifiables :");
      intelligence.evidence.slice(0, 5).forEach((value) => lines.push(`• ${value}`));
    }
    return lines.join("\n");
  }

  function runPrimaryAction(action) {
    if (action === "find-site") {
      const details = document.querySelector(".sl-site-workflow");
      if (details) details.open = true;
      document.querySelector(".site-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => document.querySelector("#find-site")?.click(), 250);
      return;
    }

    if (action === "audit-site") {
      const details = document.querySelector(".sl-site-workflow");
      if (details) details.open = true;
      document.querySelector(".site-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => document.querySelector("#audit-site")?.click(), 250);
      return;
    }

    if (action === "contact") {
      const details = document.querySelector(".sl-contact-workflow");
      if (details) details.open = true;
      document.querySelector("#contact-message")?.scrollIntoView({ behavior: "smooth", block: "center" });
      window.setTimeout(() => document.querySelector("#contact-message")?.focus(), 250);
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

    const details = document.querySelector(".sl-reasoning");
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function rebuildDecisionSection(item) {
    const section = document.querySelector("#commercial-intelligence-section");
    if (!section) return;

    const intelligence = item.commercialIntelligence;
    const presentation = getPresentation(item);
    const website = safeHostname(item.website) || (item.noSiteConfirmed ? "Aucun site" : "Non confirmé");
    const needScore = Number.isFinite(item.siteNeed?.score) ? `${item.siteNeed.score}/100` : "Non mesuré";

    section.className = `dialog-section sl-decision-section sl-tone-${presentation.tone}`;
    section.replaceChildren();

    const hero = element("div", "sl-decision-hero");
    const content = element("div", "sl-decision-content");
    const statusLine = element("div", "sl-decision-status");
    statusLine.append(
      element("span", `sl-status sl-status-${presentation.tone}`, presentation.label),
      element("span", "sl-decision-confidence", `Fiabilité ${intelligence.confidence}/100`)
    );

    content.append(
      statusLine,
      element("h3", "sl-decision-title", presentation.title),
      element("p", "sl-decision-description", presentation.description)
    );

    const score = element("div", "sl-decision-score");
    score.append(
      element("strong", "", String(intelligence.opportunityScore)),
      element("span", "", "/100 priorité")
    );
    hero.append(content, score);

    const facts = element("div", "sl-fact-grid");
    facts.append(
      createFact("Potentiel d’achat", `${item.businessScore ?? 0}/100`, "Capacité commerciale estimée"),
      createFact("Besoin numérique", needScore, Number.isFinite(item.siteNeed?.score) ? "Besoin mesuré" : "Qualification incomplète"),
      createFact("Site officiel", website, item.audit ? "Analysé" : "À vérifier")
    );

    const offer = element("div", "sl-offer-strip");
    const offerContent = element("div", "sl-offer-copy");
    offerContent.append(
      element("span", "sl-offer-label", "Prestation recommandée"),
      element("strong", "sl-offer-title", presentation.recommendation),
      element("small", "sl-offer-budget", `Budget indicatif : ${presentation.budget}`)
    );
    const primaryButton = element("button", "button button-primary sl-primary-action", presentation.actionLabel);
    primaryButton.type = "button";
    primaryButton.addEventListener("click", () => runPrimaryAction(presentation.action));
    offer.append(offerContent, primaryButton);

    const reasoning = document.createElement("details");
    reasoning.className = "sl-reasoning";
    reasoning.append(element("summary", "", "Pourquoi ce verdict ?"));
    const reasonBody = element("div", "sl-reason-body");
    const signalColumn = element("div", "sl-reason-column");
    signalColumn.append(
      element("h4", "", "Points observés"),
      createList(intelligence.signals, "Aucun problème prioritaire détecté")
    );
    const proofColumn = element("div", "sl-reason-column");
    proofColumn.append(
      element("h4", "", "Éléments vérifiables"),
      createList(intelligence.evidence, "Vérification complémentaire nécessaire")
    );
    reasonBody.append(signalColumn, proofColumn);

    const copyButton = element("button", "button button-secondary sl-copy-brief", "Copier le brief commercial");
    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(buildBrief(item, presentation));
        showNotice("Brief commercial copié.", "success");
      } catch {
        showNotice("La copie automatique a échoué.", "warning");
      }
    });
    reasonBody.append(copyButton);
    reasoning.append(reasonBody);

    section.append(hero, facts, offer, reasoning);
  }

  function createWorkflow(section, className, title, nodes) {
    let details = section.querySelector(`.${className}`);
    if (details) return details;

    details = document.createElement("details");
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
    section.className = "dialog-section site-section sl-workflow-section";
    section.querySelector(":scope > .section-heading")?.remove();
    section.querySelector(":scope > .site-guidance")?.remove();

    const details = createWorkflow(section, "sl-site-workflow", "Vérification du site", [
      section.querySelector(":scope > .site-toolbar"),
      section.querySelector(":scope > .confirmation-control"),
      section.querySelector(":scope > .site-audit-layout"),
      section.querySelector(":scope > .manual-review")
    ]);

    const caption = details.querySelector(".sl-workflow-caption");
    if (!item.website && !item.noSiteConfirmed) caption.textContent = "Site officiel à identifier";
    else if (item.website && !item.audit) caption.textContent = "Site identifié, analyse requise";
    else caption.textContent = "Analyse terminée";
    details.open = !item.website || !item.audit;

    const findButton = document.querySelector("#find-site");
    if (findButton) findButton.textContent = "Rechercher le site";
    const auditLayout = document.querySelector(".site-audit-layout");
    if (auditLayout) auditLayout.hidden = !item.website;
    const manualReview = document.querySelector(".manual-review");
    if (manualReview) manualReview.hidden = !item.audit;
  }

  function prepareContactSection(item) {
    const section = document.querySelector("#contact-title")?.closest(".dialog-section");
    if (!section) return;
    section.className = "dialog-section sl-workflow-section";

    const heading = section.querySelector(":scope > .section-heading");
    const status = section.querySelector("#prospect-status");
    const statusField = element("label", "sl-status-field");
    statusField.append(element("span", "", "Statut commercial"));
    if (status) statusField.append(status);

    const details = createWorkflow(section, "sl-contact-workflow", "Contact commercial", [
      statusField,
      section.querySelector('label[for="contact-message"]'),
      section.querySelector("#contact-message"),
      section.querySelector(".dialog-actions")
    ]);
    heading?.remove();

    const ready = ["contact_now", "secondary"].includes(item.commercialIntelligence.verdict);
    details.querySelector(".sl-workflow-caption").textContent = ready
      ? "Message prêt à personnaliser"
      : "Disponible après qualification";
    details.open = ready;
    if (dom.contactMessage) dom.contactMessage.rows = 5;
  }

  function prepareBusinessSection(item) {
    const section = document.querySelector("#business-title")?.closest(".dialog-section");
    if (!section) return;
    section.className = "dialog-section sl-workflow-section sl-business-section";

    const details = createWorkflow(section, "sl-business-workflow", "Données de l’entreprise", [
      section.querySelector("#dialog-metrics"),
      section.querySelector("#dialog-business-evidence")
    ]);
    section.querySelector(":scope > .section-heading")?.remove();
    details.querySelector(".sl-workflow-caption").textContent = `Potentiel ${item.businessScore ?? 0}/100`;
    details.open = false;
  }

  function orderDialogSections() {
    const body = document.querySelector("#prospect-dialog .dialog-body");
    const decision = document.querySelector("#commercial-intelligence-section");
    const site = document.querySelector(".site-section");
    const contact = document.querySelector(".sl-contact-workflow")?.closest(".dialog-section");
    const business = document.querySelector(".sl-business-workflow")?.closest(".dialog-section");
    if (body && decision && site && contact && business) body.append(decision, site, contact, business);
  }

  function enhanceDialog() {
    const item = selectedProspect();
    const dialog = document.querySelector("#prospect-dialog");
    if (!item?.commercialIntelligence || !dialog) return;

    dialog.classList.add("sl-prospect-dialog");
    rebuildDecisionSection(item);
    prepareSiteSection(item);
    prepareContactSection(item);
    prepareBusinessSection(item);
    orderDialogSections();
  }

  render = function renderSignalLeadProduct() {
    ORIGINAL_RENDER();
    setFilterLabels();
    enhanceTable();
  };

  syncDialog = function syncSignalLeadDialog() {
    ORIGINAL_SYNC_DIALOG();
    enhanceDialog();
  };

  render();
})();
