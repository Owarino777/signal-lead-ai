"use strict";

(function activateProductPolish() {
  if (
    typeof render !== "function"
    || typeof syncDialog !== "function"
    || typeof getVisibleItems !== "function"
  ) {
    return;
  }

  const ORIGINAL_RENDER = render;
  const ORIGINAL_SYNC_DIALOG = syncDialog;

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getWebsiteLabel(item) {
    if (item.noSiteConfirmed) return "Aucun site confirmé";
    if (!item.website) return "Site officiel à identifier";
    if (!item.audit) return "Site identifié, analyse requise";
    return "Site identifié et analysé";
  }

  function createOfferIcon() {
    const wrapper = createElement("span", "decision-offer-icon");
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.innerHTML = `
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
        <path d="M4 7.5h16v11H4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M8 7.5V5.8A1.8 1.8 0 0 1 9.8 4h4.4A1.8 1.8 0 0 1 16 5.8v1.7M4 11.5c4.8 2.4 11.2 2.4 16 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
    `;
    return wrapper;
  }

  function ensureOfferSummary(section) {
    const summary = section.querySelector(".decision-summary");
    if (!summary) return null;

    let offer = summary.querySelector(".decision-offer-summary");
    if (offer) return offer;

    offer = createElement("div", "decision-offer-summary");
    const content = createElement("div", "decision-offer-content");
    const heading = createElement("div", "decision-offer-heading");
    heading.append(
      createElement("span", "decision-offer-label", "Prestation recommandée"),
      createElement("strong", "decision-offer-title", "Diagnostic numérique ciblé")
    );
    const price = createElement("div", "decision-offer-price");
    price.append(
      createElement("span", "decision-offer-label", "Budget indicatif"),
      createElement("strong", "decision-offer-price-value", "À définir")
    );
    content.append(heading, price);

    const action = createElement("button", "button decision-copy-button", "Copier le brief");
    action.type = "button";
    action.addEventListener("click", () => {
      section.querySelector("#copy-commercial-brief")?.click();
    });

    offer.append(createOfferIcon(), content, action);
    const nextStep = summary.querySelector(".decision-next-step");
    summary.insertBefore(offer, nextStep || null);
    return offer;
  }

  function simplifyDecisionSection(item) {
    const section = document.querySelector("#commercial-intelligence-section");
    const intelligence = item.commercialIntelligence;
    if (!section || !intelligence) return;

    section.dataset.verdict = intelligence.verdict;
    const offer = ensureOfferSummary(section);
    if (offer) {
      offer.querySelector(".decision-offer-title").textContent = intelligence.primaryOffer;
      offer.querySelector(".decision-offer-price-value").textContent = intelligence.priceRange;
    }

    const details = section.querySelector(".decision-detail-disclosure");
    if (details) {
      details.querySelector(":scope > summary").textContent = "Pourquoi cette recommandation ?";
    }

    const signalsTitle = section.querySelector("#commercial-signals")?.previousElementSibling;
    const evidenceTitle = section.querySelector("#commercial-evidence")?.previousElementSibling;
    if (signalsTitle) signalsTitle.textContent = "Points observés";
    if (evidenceTitle) evidenceTitle.textContent = "Éléments vérifiables";
  }

  function createWorkflowSummary() {
    const summary = document.createElement("summary");
    const title = createElement("span", "workflow-summary-title", "Vérification du site");
    const caption = createElement("span", "workflow-summary-caption", "Site officiel à identifier");
    summary.append(title, caption);
    return summary;
  }

  function ensureSiteDisclosure(section) {
    let disclosure = section.querySelector(".site-workflow-disclosure");
    if (disclosure) return disclosure;

    disclosure = document.createElement("details");
    disclosure.className = "site-workflow-disclosure";
    disclosure.append(createWorkflowSummary());

    const movable = [
      section.querySelector(".site-toolbar"),
      section.querySelector(".confirmation-control"),
      section.querySelector(".site-audit-layout"),
      section.querySelector(".manual-review-disclosure"),
      section.querySelector(".manual-review")
    ].filter(Boolean);

    disclosure.append(...movable);
    section.append(disclosure);
    return disclosure;
  }

  function simplifySiteSection(item) {
    const section = document.querySelector(".site-section");
    if (!section) return;

    const disclosure = ensureSiteDisclosure(section);
    const caption = disclosure.querySelector(".workflow-summary-caption");
    if (caption) caption.textContent = getWebsiteLabel(item);

    disclosure.open = !item.website || !item.audit;
    section.dataset.state = item.audit
      ? "analyzed"
      : item.website
        ? "identified"
        : "pending";
  }

  function simplifyContactSection(item) {
    const section = document.querySelector("#contact-title")?.closest(".dialog-section");
    const disclosure = section?.querySelector(".contact-workflow-disclosure");
    if (!section || !disclosure) return;

    section.classList.add("workflow-secondary-section");
    const ready = ["contact_now", "secondary"].includes(item.commercialIntelligence?.verdict);
    disclosure.open = ready;
    disclosure.querySelector(":scope > summary").textContent = ready
      ? "Préparer le contact commercial"
      : "Contact commercial — disponible après qualification";
  }

  function simplifyBusinessSection(item) {
    const section = document.querySelector("#business-title")?.closest(".dialog-section");
    const disclosure = section?.querySelector(".business-detail-disclosure");
    if (!section || !disclosure) return;

    section.classList.add("workflow-secondary-section", "business-secondary-section");
    disclosure.open = false;
    disclosure.querySelector(":scope > summary").textContent = "Données juridiques et financières";
    section.dataset.businessScore = String(item.businessScore ?? 0);
  }

  function enhanceRows() {
    const visibleItems = getVisibleItems();
    const rows = [...dom.results.querySelectorAll("tr")];

    rows.forEach((row, index) => {
      const item = visibleItems[index];
      const button = row.querySelector(".row-actions button");
      if (!item || !button || row.dataset.interactive === "true") return;

      row.dataset.interactive = "true";
      row.tabIndex = 0;
      row.setAttribute("aria-label", `Ouvrir l’analyse de ${item.commercialName || item.name}`);
      row.addEventListener("click", (event) => {
        if (event.target.closest("button, a, input, select, textarea")) return;
        button.click();
      });
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        button.click();
      });
    });
  }

  function simplifyDialog() {
    const item = selectedProspect();
    const dialog = document.querySelector("#prospect-dialog");
    if (!item?.commercialIntelligence || !dialog) return;

    dialog.dataset.verdict = item.commercialIntelligence.verdict;
    simplifyDecisionSection(item);
    simplifySiteSection(item);
    simplifyContactSection(item);
    simplifyBusinessSection(item);
  }

  render = function renderPolishedProduct() {
    ORIGINAL_RENDER();
    enhanceRows();
  };

  syncDialog = function syncPolishedDialog() {
    ORIGINAL_SYNC_DIALOG();
    simplifyDialog();
  };

  render();
})();
