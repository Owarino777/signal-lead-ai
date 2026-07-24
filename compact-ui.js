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

    const confidence = createText(
      "span",
      "compact-confidence",
      `Confiance ${intelligence.confidence}/100`
    );

    cell.append(layout, confidence);
  }

  function renderRecommendationCell(cell, item, intelligence) {
    cell.replaceChildren();
    cell.dataset.label = "Recommandation";
    cell.classList.add("compact-recommendation-cell");

    const signal = createText("strong", "compact-signal", intelligence.primarySignal);
    const offer = createText("span", "compact-offer", intelligence.primaryOffer);
    const metadata = document.createElement("span");
    metadata.className = "compact-metadata";

    const hostname = safeHostname(item.website);
    metadata.textContent = hostname
      ? `${hostname} · ${intelligence.priceRange}`
      : `${intelligence.priceRange} · site à confirmer`;

    cell.append(signal, offer, metadata);
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

  function compactCommercialSection() {
    const section = document.querySelector("#commercial-intelligence-section");
    if (!section) return;
    section.classList.add("compact-commercial-section");

    const overviewArticles = [...section.querySelectorAll(".commercial-overview article")];
    if (overviewArticles[1]) overviewArticles[1].classList.add("compact-secondary-metric");

    if (!section.querySelector(".commercial-detail-disclosure")) {
      const columns = section.querySelector(".commercial-columns");
      const confidence = section.querySelector(".commercial-confidence-grid");
      const copyButton = section.querySelector("#copy-commercial-brief");

      if (columns && confidence) {
        const details = createDisclosure(
          "Voir les preuves et le niveau de confiance",
          "commercial-detail-disclosure"
        );
        details.append(columns, confidence);
        section.insertBefore(details, copyButton || null);
      }
    }
  }

  function compactBusinessSection() {
    const title = document.querySelector("#business-title");
    const section = title?.closest(".dialog-section");
    if (!section || section.querySelector(".business-detail-disclosure")) return;

    const heading = section.querySelector(".section-heading");
    const content = [...section.children].filter((element) => element !== heading);
    if (!content.length) return;

    const details = createDisclosure(
      "Voir les informations juridiques et financières",
      "business-detail-disclosure"
    );
    details.append(...content);
    section.append(details);
    section.classList.add("compact-secondary-section");
  }

  function compactManualReview() {
    const fieldset = document.querySelector(".manual-review");
    if (!fieldset || fieldset.closest(".manual-review-disclosure")) return;

    const details = createDisclosure(
      "Effectuer un contrôle visuel manuel",
      "manual-review-disclosure"
    );
    fieldset.before(details);
    details.append(fieldset);
  }

  function compactDialog() {
    const dialog = document.querySelector("#prospect-dialog");
    if (!dialog) return;
    dialog.classList.add("compact-dialog");

    compactCommercialSection();
    compactBusinessSection();
    compactManualReview();

    if (dom.contactMessage) {
      dom.contactMessage.rows = 5;
    }
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
