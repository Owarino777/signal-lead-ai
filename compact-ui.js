"use strict";

(function activateCompactInterface() {
  if (
    typeof render !== "function"
    || typeof syncDialog !== "function"
    || typeof getVisibleItems !== "function"
  ) {
    return;
  }

  const ORIGINAL_RENDER = render;
  const ORIGINAL_SYNC_DIALOG = syncDialog;

  function safeHostname(value) {
    if (!value) return null;
    try {
      return new URL(value).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function createText(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function getVerdictClass(verdict) {
    const classes = {
      contact_now: "bad",
      secondary: "neutral",
      verify: "pending",
      equipped: "good",
      low_fit: "muted"
    };
    return classes[verdict] || "pending";
  }

  function renderOpportunityCell(cell, intelligence) {
    cell.replaceChildren();
    cell.dataset.label = "Opportunité";
    cell.classList.add("compact-opportunity-cell");

    const layout = document.createElement("div");
    layout.className = "compact-opportunity";
    layout.append(
      createText("strong", "compact-score", `${intelligence.opportunityScore}/100`),
      createBadge(intelligence.verdictLabel, getVerdictClass(intelligence.verdict))
    );

    cell.append(
      layout,
      createText("span", "compact-confidence", `Confiance ${intelligence.confidence}/100`)
    );
  }

  function renderRecommendationCell(cell, item, intelligence) {
    cell.replaceChildren();
    cell.dataset.label = "Recommandation";
    cell.classList.add("compact-recommendation-cell");

    const hostname = safeHostname(item.website);
    cell.append(
      createText("strong", "compact-signal", intelligence.primarySignal),
      createText("span", "compact-offer", intelligence.primaryOffer),
      createText(
        "span",
        "compact-metadata",
        hostname
          ? `${hostname} · ${intelligence.priceRange}`
          : `${intelligence.priceRange} · site à confirmer`
      )
    );
  }

  function compactTable() {
    const table = document.querySelector(".prospect-table");
    if (!table) return;
    table.classList.add("compact-table");

    const headers = [...table.querySelectorAll("thead th")];
    if (headers.length >= 6) {
      headers[0].textContent = "Entreprise";
      headers[1].textContent = "Opportunité";
      headers[2].textContent = "Recommandation";
      headers[3].classList.add("compact-hidden");
      headers[4].classList.add("compact-hidden");
      headers[5].innerHTML = '<span class="visually-hidden">Actions</span>';
    }

    const visibleItems = getVisibleItems();
    const rows = [...dom.results.querySelectorAll("tr")];

    rows.forEach((row, index) => {
      const item = visibleItems[index];
      const intelligence = item?.commercialIntelligence;
      const cells = [...row.querySelectorAll("td")];
      if (!item || !intelligence || cells.length < 6) return;

      row.classList.add("compact-row");
      row.dataset.verdict = intelligence.verdict;
      cells[0].dataset.label = "Entreprise";
      renderOpportunityCell(cells[1], intelligence);
      renderRecommendationCell(cells[2], item, intelligence);
      cells[3].classList.add("compact-hidden");
      cells[4].classList.add("compact-hidden");
      cells[5].dataset.label = "Actions";

      const button = cells[5].querySelector("button");
      if (button) {
        button.textContent = "Analyser";
        button.setAttribute("aria-label", `Analyser ${item.commercialName || item.name}`);
      }
    });
  }

  function createDisclosure(summaryText, className) {
    const details = document.createElement("details");
    details.className = className;
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.append(summary);
    return details;
  }

  function getDecisionModel(item, intelligence) {
    const businessScore = item.businessScore ?? 0;
    const siteConfirmed = Boolean(item.website || item.noSiteConfirmed);
    const auditCompleted = Boolean(item.audit);

    if (intelligence.verdict === "contact_now") {
      return {
        title: "Prospect prêt à contacter",
        description: `L’entreprise présente un potentiel de ${businessScore}/100 et un besoin numérique suffisamment confirmé. Vous pouvez préparer une prise de contact ciblée.`,
        actionLabel: "Préparer le contact",
        actionHelp: "Utilisez les preuves vérifiées pour personnaliser votre message.",
        action: "contact",
        buttonText: "Préparer le message"
      };
    }

    if (intelligence.verdict === "secondary") {
      return {
        title: "Prospect intéressant, mais non prioritaire",
        description: `L’entreprise peut acheter, mais le besoin détecté ne justifie pas encore une refonte complète. Une offre ciblée reste possible.`,
        actionLabel: "Vérifier l’opportunité secondaire",
        actionHelp: "Consultez les preuves avant de proposer une prestation limitée.",
        action: "details",
        buttonText: "Voir l’analyse"
      };
    }

    if (intelligence.verdict === "equipped") {
      return {
        title: "Refonte complète peu pertinente",
        description: "Le site paraît déjà suffisamment professionnel. Ne proposez pas une refonte complète sans identifier un besoin plus précis.",
        actionLabel: "Chercher une prestation complémentaire",
        actionHelp: "Accessibilité, SEO local, conversion ou maintenance peuvent rester pertinents.",
        action: "details",
        buttonText: "Voir les alternatives"
      };
    }

    if (intelligence.verdict === "low_fit") {
      return {
        title: "Prospect à écarter pour le moment",
        description: "La capacité commerciale estimée est trop faible ou la structure correspond mal à votre offre actuelle.",
        actionLabel: "Classer le prospect",
        actionHelp: "Écartez-le pour concentrer votre temps sur les meilleures opportunités.",
        action: "ignore",
        buttonText: "Marquer comme ignoré"
      };
    }

    if (!siteConfirmed) {
      return {
        title: "Ne contactez pas encore ce prospect",
        description: `L’entreprise semble capable d’acheter (${businessScore}/100), mais son site officiel n’est pas confirmé. Le besoin numérique reste donc inconnu, ce qui limite la priorité à ${intelligence.opportunityScore}/100.`,
        actionLabel: "Identifier le site officiel",
        actionHelp: "Recherchez le site exact ou confirmez qu’aucun site officiel n’existe.",
        action: "find-site",
        buttonText: "Rechercher le site"
      };
    }

    if (!auditCompleted) {
      return {
        title: "Analyse du site nécessaire",
        description: `Le site officiel est identifié, mais son besoin numérique n’a pas encore été mesuré. Le potentiel commercial de ${businessScore}/100 ne suffit pas à recommander un contact.`,
        actionLabel: "Analyser le site officiel",
        actionHelp: "L’analyse déterminera si une prestation peut réellement être proposée.",
        action: "audit-site",
        buttonText: "Analyser le site"
      };
    }

    return {
      title: "Vérification complémentaire nécessaire",
      description: "Certaines informations restent incertaines. Consultez les preuves avant de décider de contacter ou d’écarter ce prospect.",
      actionLabel: "Contrôler les preuves",
      actionHelp: "Vérifiez l’identité du site et les problèmes détectés.",
      action: "details",
      buttonText: "Voir l’analyse"
    };
  }

  function createDecisionMetric(label, valueId, captionId) {
    const article = document.createElement("article");
    article.className = "decision-metric";
    article.append(
      createText("span", "decision-metric-label", label),
      createText("strong", "decision-metric-value", "—"),
      createText("small", "decision-metric-caption", "")
    );
    article.querySelector("strong").id = valueId;
    article.querySelector("small").id = captionId;
    return article;
  }

  function ensureDecisionLayout() {
    const section = document.querySelector("#commercial-intelligence-section");
    if (!section) return null;
    section.classList.add("decision-section");

    let summary = section.querySelector(".decision-summary");
    if (summary) return section;

    const originalHeading = section.querySelector(":scope > .section-heading");
    if (originalHeading) originalHeading.classList.add("decision-original-heading");

    summary = document.createElement("div");
    summary.className = "decision-summary";
    summary.innerHTML = `
      <div class="decision-heading">
        <div>
          <p class="eyebrow">Recommandation SignalLead</p>
          <div class="decision-status-line">
            <span class="status-badge pending" id="decision-verdict">À vérifier</span>
            <span id="decision-confidence">Confiance —</span>
          </div>
          <h3 id="decision-title">Décision en cours</h3>
          <p id="decision-description"></p>
        </div>
      </div>
      <div class="decision-steps" aria-label="Étapes de qualification">
        <span data-decision-step="site"><b>1</b> Identifier le site</span>
        <span data-decision-step="need"><b>2</b> Confirmer le besoin</span>
        <span data-decision-step="contact"><b>3</b> Contacter</span>
      </div>
      <div class="decision-metrics"></div>
      <div class="decision-next-step">
        <div>
          <span>Prochaine étape</span>
          <strong id="decision-action-label">Vérifier le prospect</strong>
          <small id="decision-action-help"></small>
        </div>
        <button class="button button-primary" id="decision-primary-action" type="button">Continuer</button>
      </div>
    `;

    const metrics = summary.querySelector(".decision-metrics");
    metrics.append(
      createDecisionMetric("Priorité de contact", "decision-priority", "decision-priority-caption"),
      createDecisionMetric("Potentiel entreprise", "decision-business", "decision-business-caption"),
      createDecisionMetric("Besoin numérique", "decision-need", "decision-need-caption")
    );

    const detailContent = document.createElement("div");
    detailContent.className = "decision-detail-content";

    const detailElements = [
      section.querySelector(".commercial-overview"),
      section.querySelector(".commercial-recommendation"),
      section.querySelector(".commercial-detail-disclosure"),
      section.querySelector("#copy-commercial-brief")
    ].filter(Boolean);

    detailContent.append(...detailElements);
    const details = createDisclosure("Voir l’analyse détaillée", "decision-detail-disclosure");
    details.append(detailContent);

    section.append(summary, details);

    summary.querySelector("#decision-primary-action").addEventListener("click", () => {
      executeDecisionAction(summary.querySelector("#decision-primary-action").dataset.action);
    });

    return section;
  }

  function executeDecisionAction(action) {
    if (action === "find-site") {
      document.querySelector(".site-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => document.querySelector("#find-site")?.click(), 250);
      return;
    }

    if (action === "audit-site") {
      document.querySelector(".site-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => document.querySelector("#audit-site")?.click(), 250);
      return;
    }

    if (action === "contact") {
      document.querySelector("#contact-title")?.closest(".dialog-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => document.querySelector("#contact-message")?.focus(), 300);
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

    const details = document.querySelector(".decision-detail-disclosure");
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  function syncDecisionSteps(item, intelligence) {
    const siteCompleted = Boolean(item.website || item.noSiteConfirmed);
    const needCompleted = Boolean(item.audit || item.noSiteConfirmed);
    const contactReady = ["contact_now", "secondary"].includes(intelligence.verdict);
    const steps = [...document.querySelectorAll("[data-decision-step]")];

    steps.forEach((step) => step.classList.remove("is-complete", "is-active"));
    const siteStep = document.querySelector('[data-decision-step="site"]');
    const needStep = document.querySelector('[data-decision-step="need"]');
    const contactStep = document.querySelector('[data-decision-step="contact"]');

    if (siteCompleted) siteStep?.classList.add("is-complete");
    if (needCompleted) needStep?.classList.add("is-complete");
    if (contactReady) contactStep?.classList.add("is-complete");

    if (!siteCompleted) siteStep?.classList.add("is-active");
    else if (!needCompleted) needStep?.classList.add("is-active");
    else if (!contactReady) contactStep?.classList.add("is-active");
  }

  function syncDecisionLayout(item) {
    const section = ensureDecisionLayout();
    if (!section) return;

    const intelligence = item.commercialIntelligence;
    if (!intelligence) return;
    const model = getDecisionModel(item, intelligence);
    const needScore = item.siteNeed?.score;
    const verdict = section.querySelector("#decision-verdict");

    verdict.className = `status-badge ${getVerdictClass(intelligence.verdict)}`;
    verdict.textContent = intelligence.verdictLabel;
    section.querySelector("#decision-confidence").textContent = `Confiance ${intelligence.confidence}/100`;
    section.querySelector("#decision-title").textContent = model.title;
    section.querySelector("#decision-description").textContent = model.description;
    section.querySelector("#decision-priority").textContent = `${intelligence.opportunityScore}/100`;
    section.querySelector("#decision-priority-caption").textContent = "Décision finale pour la prospection";
    section.querySelector("#decision-business").textContent = `${item.businessScore ?? 0}/100`;
    section.querySelector("#decision-business-caption").textContent = "Capacité estimée à acheter";
    section.querySelector("#decision-need").textContent = Number.isFinite(needScore) ? `${needScore}/100` : "Inconnu";
    section.querySelector("#decision-need-caption").textContent = Number.isFinite(needScore)
      ? "Besoin mesuré sur le site"
      : "Site non confirmé ou non analysé";
    section.querySelector("#decision-action-label").textContent = model.actionLabel;
    section.querySelector("#decision-action-help").textContent = model.actionHelp;

    const actionButton = section.querySelector("#decision-primary-action");
    actionButton.textContent = model.buttonText;
    actionButton.dataset.action = model.action;

    syncDecisionSteps(item, intelligence);
  }

  function compactBusinessSection(item) {
    const title = document.querySelector("#business-title");
    const section = title?.closest(".dialog-section");
    if (!section) return;

    title.textContent = "Données de l’entreprise";
    const score = section.querySelector("#dialog-business-score");
    if (score) score.textContent = `${item.businessScore ?? 0}/100 potentiel`;

    let details = section.querySelector(".business-detail-disclosure");
    if (!details) {
      const heading = section.querySelector(".section-heading");
      const content = [...section.children].filter((element) => element !== heading);
      details = createDisclosure("Voir les informations juridiques et financières", "business-detail-disclosure");
      details.append(...content);
      section.append(details);
    }

    details.querySelector("summary").textContent = `Pourquoi le potentiel est évalué à ${item.businessScore ?? 0}/100`;
    section.classList.add("compact-secondary-section");
  }

  function compactManualReview(item) {
    const fieldset = document.querySelector(".manual-review");
    if (!fieldset) return;

    let details = fieldset.closest(".manual-review-disclosure");
    if (!details) {
      details = createDisclosure("Effectuer un contrôle visuel manuel", "manual-review-disclosure");
      fieldset.before(details);
      details.append(fieldset);
    }

    details.hidden = !item.audit;
  }

  function compactSiteSection(item) {
    const section = document.querySelector(".site-section");
    if (!section) return;

    const title = section.querySelector("#site-title");
    const heading = section.querySelector(".section-heading");
    let guidance = section.querySelector("#site-guidance");
    if (!guidance) {
      guidance = createText("p", "site-guidance", "");
      heading?.after(guidance);
    }

    if (!item.website && !item.noSiteConfirmed) {
      title.textContent = "1. Identifier le site officiel";
      guidance.textContent = "Cette étape est obligatoire avant toute prise de contact. Recherchez l’URL exacte ou confirmez qu’aucun site officiel n’existe.";
    } else if (item.website && !item.audit) {
      title.textContent = "1. Analyser le site officiel";
      guidance.textContent = "Le site est identifié. Lancez l’analyse pour mesurer le besoin numérique réel avant de contacter l’entreprise.";
    } else {
      title.textContent = "Analyse du site officiel";
      guidance.textContent = "Le besoin numérique a été analysé. Vérifiez les résultats détaillés uniquement si une décision reste incertaine.";
    }

    const auditLayout = section.querySelector(".site-audit-layout");
    if (auditLayout) auditLayout.hidden = !item.website;
    compactManualReview(item);
  }

  function compactContactSection(item) {
    const title = document.querySelector("#contact-title");
    const section = title?.closest(".dialog-section");
    if (!section) return;

    title.textContent = "2. Préparer le contact";
    let details = section.querySelector(".contact-workflow-disclosure");
    if (!details) {
      const heading = section.querySelector(".section-heading");
      const content = [...section.children].filter((element) => element !== heading);
      details = createDisclosure("Ouvrir la préparation du contact", "contact-workflow-disclosure");
      details.append(...content);
      section.append(details);
    }

    const verdict = item.commercialIntelligence?.verdict;
    details.querySelector("summary").textContent = ["contact_now", "secondary"].includes(verdict)
      ? "Préparer le message et le suivi commercial"
      : "Préparation du contact — à utiliser après qualification";
    section.classList.toggle("is-deferred", !["contact_now", "secondary"].includes(verdict));

    if (dom.contactMessage) dom.contactMessage.rows = 5;
  }

  function reorderDialogSections() {
    const body = document.querySelector("#prospect-dialog .dialog-body");
    const decision = document.querySelector("#commercial-intelligence-section");
    const site = document.querySelector(".site-section");
    const contact = document.querySelector("#contact-title")?.closest(".dialog-section");
    const business = document.querySelector("#business-title")?.closest(".dialog-section");
    if (!body || !decision || !site || !contact || !business) return;
    body.append(decision, site, contact, business);
  }

  function compactDialog() {
    const dialog = document.querySelector("#prospect-dialog");
    const item = selectedProspect();
    if (!dialog || !item?.commercialIntelligence) return;

    dialog.classList.add("compact-dialog");
    syncDecisionLayout(item);
    compactSiteSection(item);
    compactContactSection(item);
    compactBusinessSection(item);
    reorderDialogSections();
  }

  render = function renderCompactInterface() {
    ORIGINAL_RENDER();
    compactTable();
  };

  syncDialog = function syncCompactDialog() {
    ORIGINAL_SYNC_DIALOG();
    compactDialog();
  };

  render();
})();
