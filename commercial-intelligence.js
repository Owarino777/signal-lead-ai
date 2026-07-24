"use strict";

(function activateCommercialIntelligence() {
  if (
    typeof updatePriority !== "function"
    || typeof getVisibleItems !== "function"
    || typeof render !== "function"
    || typeof syncDialog !== "function"
  ) {
    return;
  }

  const ORIGINAL_UPDATE_PRIORITY = updatePriority;
  const ORIGINAL_GET_VISIBLE_ITEMS = getVisibleItems;
  const ORIGINAL_RENDER = render;
  const ORIGINAL_SYNC_DIALOG = syncDialog;

  const VERDICTS = Object.freeze({
    contact_now: Object.freeze({ label: "À contacter", className: "bad", rank: 5 }),
    secondary: Object.freeze({ label: "Opportunité secondaire", className: "neutral", rank: 4 }),
    verify: Object.freeze({ label: "À vérifier", className: "pending", rank: 3 }),
    equipped: Object.freeze({ label: "Déjà bien équipé", className: "good", rank: 2 }),
    low_fit: Object.freeze({ label: "Faible adéquation", className: "muted", rank: 1 })
  });

  const SEGMENT_OFFERS = Object.freeze({
    fastfood: Object.freeze({
      noSite: "Site de commande et visibilité locale",
      conversion: "Parcours de commande ou livraison",
      mobile: "Refonte mobile orientée conversion",
      seo: "Référencement local et pages établissement",
      trust: "Avis, preuves sociales et réassurance",
      structure: "Refonte technique et éditoriale",
      maintenance: "Optimisation continue du site"
    }),
    restaurants: Object.freeze({
      noSite: "Site avec réservation, menu et visibilité locale",
      conversion: "Réservation et demandes de groupe",
      mobile: "Refonte mobile du parcours client",
      seo: "Référencement local et données restaurant",
      trust: "Avis, photos et preuve de qualité",
      structure: "Refonte technique et contenus",
      maintenance: "Optimisation continue du site"
    }),
    food: Object.freeze({
      noSite: "Site avec commande, réservation et menu",
      conversion: "Commande ou réservation en ligne",
      mobile: "Refonte mobile orientée conversion",
      seo: "Référencement local",
      trust: "Avis, photos et réassurance",
      structure: "Refonte technique et éditoriale",
      maintenance: "Optimisation continue du site"
    }),
    building: Object.freeze({
      noSite: "Site de génération de demandes de devis",
      conversion: "Tunnel de demande de devis",
      mobile: "Refonte mobile pour les demandes locales",
      seo: "Référencement local par métier et zone",
      trust: "Réalisations, certifications et avis",
      structure: "Refonte technique et contenus métiers",
      maintenance: "Optimisation continue du site"
    })
  });

  const MANUAL_LABELS = Object.freeze({
    datedDesign: "Design visuellement daté",
    poorMobile: "Affichage mobile peu convaincant",
    weakConversion: "Action commerciale peu visible",
    weakTrust: "Peu de preuves ou de réassurance",
    confusingNavigation: "Navigation confuse",
    siteGood: "Site jugé professionnel"
  });

  function getOfferCatalog(item) {
    return SEGMENT_OFFERS[item.segment] || SEGMENT_OFFERS.fastfood;
  }

  function hasManualIssue(item, issue) {
    return Array.isArray(item.manualIssues) && item.manualIssues.includes(issue);
  }

  function getMetric(item, name) {
    const value = Number(item.audit?.metrics?.[name]);
    return Number.isFinite(value) ? value : null;
  }

  function unique(values, limit = 8) {
    return [...new Set(values.filter(Boolean))].slice(0, limit);
  }

  function deriveSignals(item) {
    const signals = [];
    const offers = [];
    const evidence = [];
    const catalog = getOfferCatalog(item);
    const mobile = getMetric(item, "mobile");
    const seo = getMetric(item, "seo");
    const structure = getMetric(item, "structure");
    const conversion = getMetric(item, "conversion");

    if (item.noSiteConfirmed) {
      signals.push("Aucun site officiel confirmé");
      offers.push(catalog.noSite, catalog.seo, catalog.trust);
      evidence.push("Absence de site confirmée manuellement");
    } else if (!item.website) {
      signals.push("Site officiel encore non confirmé");
      offers.push(catalog.noSite);
      evidence.push("Aucun domaine suffisamment fiable n’a été validé");
    }

    if (mobile !== null && mobile < 65) {
      signals.push("Expérience mobile insuffisante");
      offers.push(catalog.mobile);
      evidence.push(`Score mobile : ${mobile}/100`);
    }

    if (conversion !== null && conversion < 58) {
      signals.push(item.segment === "building"
        ? "Demande de devis peu visible"
        : "Commande ou réservation peu visible");
      offers.push(catalog.conversion);
      evidence.push(`Score de conversion : ${conversion}/100`);
    }

    if (seo !== null && seo < 60) {
      signals.push("Référencement de base perfectible");
      offers.push(catalog.seo);
      evidence.push(`Score SEO : ${seo}/100`);
    }

    if (structure !== null && structure < 58) {
      signals.push("Structure technique perfectible");
      offers.push(catalog.structure);
      evidence.push(`Score de structure : ${structure}/100`);
    }

    if (hasManualIssue(item, "datedDesign")) {
      signals.push("Design visuellement daté");
      offers.push(catalog.structure);
    }
    if (hasManualIssue(item, "poorMobile")) {
      signals.push("Expérience mobile à reprendre");
      offers.push(catalog.mobile);
    }
    if (hasManualIssue(item, "weakConversion")) {
      signals.push("Parcours commercial insuffisant");
      offers.push(catalog.conversion);
    }
    if (hasManualIssue(item, "weakTrust")) {
      signals.push("Preuves de confiance insuffisantes");
      offers.push(catalog.trust);
    }
    if (hasManualIssue(item, "confusingNavigation")) {
      signals.push("Navigation difficile à comprendre");
      offers.push(catalog.structure);
    }

    for (const auditEvidence of item.audit?.evidence || []) {
      evidence.push(sanitizeText(auditEvidence, 260));
    }
    for (const manualIssue of item.manualIssues || []) {
      if (MANUAL_LABELS[manualIssue]) evidence.push(MANUAL_LABELS[manualIssue]);
    }
    for (const businessEvidence of item.businessEvidence || []) {
      evidence.push(sanitizeText(businessEvidence, 260));
    }

    if (!offers.length && item.audit) offers.push(catalog.maintenance);

    return {
      signals: unique(signals, 6),
      offers: unique(offers, 5),
      evidence: unique(evidence, 10)
    };
  }

  function getIdentityConfidence(item) {
    if (item.noSiteConfirmed) return 95;
    if (!item.website) return item.websiteDiscoveryStatus === "not_found" ? 35 : 20;
    if (item.websiteSource === "Correction manuelle") return 98;
    if (item.audit && Number.isFinite(item.websiteConfidence)) {
      return clamp(Math.max(65, item.websiteConfidence * 100));
    }
    if (Number.isFinite(item.websiteConfidence)) return clamp(item.websiteConfidence * 100);
    return item.audit ? 70 : 50;
  }

  function getNeedConfidence(item) {
    if (item.noSiteConfirmed) return 92;
    if (item.audit && item.manualIssues?.length) return 94;
    if (item.audit) return 78;
    if (item.website) return 48;
    return 28;
  }

  function getBuyingConfidence(item) {
    let score = 40;
    if (item.revenue !== null) score += 18;
    if (item.employees !== null) score += 12;
    if (item.employer) score += 8;
    if (item.establishments >= 1 && item.establishments <= 5) score += 7;
    if (item.creationDate) score += 5;
    return clamp(score);
  }

  function getPriceRange(item, verdict) {
    const building = item.segment === "building";
    const needScore = item.siteNeed?.score ?? 0;

    if (verdict === "contact_now") {
      if (item.noSiteConfirmed || needScore >= 78) {
        return building ? "2 500 € – 6 500 €" : "1 800 € – 4 500 €";
      }
      return building ? "1 500 € – 4 000 €" : "1 200 € – 3 200 €";
    }
    if (verdict === "secondary") {
      return building ? "900 € – 2 500 €" : "700 € – 2 000 €";
    }
    if (verdict === "equipped") return "300 € – 1 200 €";
    return "À définir après validation";
  }

  function classifyVerdict(item) {
    const businessScore = item.businessScore ?? 0;
    const needScore = item.siteNeed?.score ?? null;
    const auditQuality = item.audit?.quality ?? null;
    const uncertainIdentity = !item.noSiteConfirmed && (
      !item.website
      || item.websiteDiscoveryStatus === "searching"
      || item.websiteDiscoveryStatus === "deferred"
      || item.websiteDiscoveryStatus === "enrichment_failed"
      || item.websiteDiscoveryStatus === "not_found"
    );

    if (businessScore < 42) return "low_fit";
    if (uncertainIdentity || needScore === null) return "verify";
    if (hasManualIssue(item, "siteGood") || (auditQuality !== null && auditQuality >= 76 && needScore < 38)) {
      return "equipped";
    }
    if (businessScore >= 58 && needScore >= 62) return "contact_now";
    if (businessScore >= 52 && needScore >= 38) return "secondary";
    if (needScore < 38) return "equipped";
    return "verify";
  }

  function deriveCommercialIntelligence(item) {
    const derived = deriveSignals(item);
    const verdict = classifyVerdict(item);
    const identityConfidence = getIdentityConfidence(item);
    const needConfidence = getNeedConfidence(item);
    const buyingConfidence = getBuyingConfidence(item);
    const confidence = clamp(
      identityConfidence * 0.34
      + needConfidence * 0.38
      + buyingConfidence * 0.28
    );

    const rawScore = item.finalPriority ?? clamp(item.businessScore * 0.45);
    const uncertaintyPenalty = verdict === "verify" ? 24 : verdict === "low_fit" ? 18 : 0;
    const opportunityScore = clamp(rawScore - uncertaintyPenalty);
    const primarySignal = derived.signals[0]
      || (verdict === "equipped" ? "Site globalement satisfaisant" : "Qualification complémentaire nécessaire");

    return {
      verdict,
      verdictLabel: VERDICTS[verdict].label,
      opportunityScore,
      primarySignal,
      signals: derived.signals,
      recommendedOffers: derived.offers,
      primaryOffer: derived.offers[0] || "Diagnostic numérique ciblé",
      priceRange: getPriceRange(item, verdict),
      confidence,
      confidenceDetails: {
        identity: identityConfidence,
        need: needConfidence,
        buying: buyingConfidence
      },
      evidence: derived.evidence
    };
  }

  function createActionableMessage(item) {
    const intelligence = item.commercialIntelligence || deriveCommercialIntelligence(item);
    const company = item.commercialName || item.name;
    const evidence = intelligence.evidence
      .filter((value) => !/chiffre d’affaires non publié/i.test(value))
      .slice(0, 2);
    const evidenceSentence = evidence.length
      ? `J’ai relevé notamment ${evidence.join(" ainsi que ").toLowerCase()}.`
      : `J’ai identifié un point d’amélioration concret concernant ${intelligence.primarySignal.toLowerCase()}.`;

    return [
      "Bonjour,",
      "",
      `Je me permets de vous contacter au sujet de ${company}.`,
      "",
      `${evidenceSentence}`,
      "",
      `Je travaille sur des projets de ${intelligence.primaryOffer.toLowerCase()} et je peux vous transmettre un diagnostic court avec les améliorations prioritaires, sans engagement.`,
      "",
      "Seriez-vous disponible pour un échange de 15 minutes ?",
      "",
      "Bien cordialement,"
    ].join("\n");
  }

  function createCommercialBrief(item) {
    const intelligence = item.commercialIntelligence || deriveCommercialIntelligence(item);
    const lines = [
      `${item.commercialName || item.name}`,
      `Verdict : ${intelligence.verdictLabel}`,
      `Opportunité : ${intelligence.opportunityScore}/100`,
      `Confiance : ${intelligence.confidence}/100`,
      "",
      `Signal principal : ${intelligence.primarySignal}`,
      `Offre recommandée : ${intelligence.primaryOffer}`,
      `Fourchette commerciale : ${intelligence.priceRange}`,
      ""
    ];

    if (intelligence.signals.length) {
      lines.push("Signaux détectés :");
      for (const signal of intelligence.signals) lines.push(`• ${signal}`);
      lines.push("");
    }

    if (intelligence.evidence.length) {
      lines.push("Preuves :");
      for (const evidence of intelligence.evidence.slice(0, 6)) lines.push(`• ${evidence}`);
    }

    return lines.join("\n");
  }

  function ensureFilterOptions() {
    const select = document.querySelector("#qualification-filter");
    if (!select || select.querySelector('option[value="contact_now"]')) return;

    select.replaceChildren(
      new Option("Toutes les qualifications", "all"),
      new Option("À contacter", "contact_now"),
      new Option("Opportunités secondaires", "secondary"),
      new Option("À vérifier", "verify"),
      new Option("Déjà bien équipés", "equipped"),
      new Option("Faible adéquation", "low_fit")
    );
  }

  function getCommercialVisibleItems() {
    const query = sanitizeText(dom.filter.value, 120).toLowerCase();
    const qualification = dom.qualificationFilter.value;
    const sort = dom.sort.value;

    const items = state.items.filter((item) => {
      const intelligence = item.commercialIntelligence || deriveCommercialIntelligence(item);
      if (query && ![
        item.name,
        item.commercialName,
        item.city,
        item.address,
        item.activityLabel,
        intelligence.primarySignal,
        intelligence.primaryOffer
      ].join(" ").toLowerCase().includes(query)) return false;
      if (qualification !== "all" && intelligence.verdict !== qualification) return false;
      return true;
    });

    return items.sort((left, right) => {
      const leftIntelligence = left.commercialIntelligence || deriveCommercialIntelligence(left);
      const rightIntelligence = right.commercialIntelligence || deriveCommercialIntelligence(right);
      if (sort === "business") return right.businessScore - left.businessScore;
      if (sort === "site") return (right.siteNeed?.score ?? -1) - (left.siteNeed?.score ?? -1);
      if (sort === "revenue") return (right.revenue ?? -1) - (left.revenue ?? -1);
      if (sort === "name") return (left.commercialName || left.name).localeCompare(right.commercialName || right.name, "fr");
      return VERDICTS[rightIntelligence.verdict].rank - VERDICTS[leftIntelligence.verdict].rank
        || rightIntelligence.opportunityScore - leftIntelligence.opportunityScore
        || right.businessScore - left.businessScore;
    });
  }

  function setCellContent(cell, title, caption, badgeClass = null) {
    cell.replaceChildren();
    if (badgeClass) {
      const badge = createBadge(title, badgeClass);
      cell.append(badge);
    } else {
      const strong = document.createElement("strong");
      strong.className = "commercial-cell-title";
      strong.textContent = title;
      cell.append(strong);
    }
    if (caption) {
      const small = document.createElement("span");
      small.className = "commercial-cell-caption";
      small.textContent = caption;
      cell.append(small);
    }
  }

  function enhanceRenderedTable() {
    const headers = document.querySelectorAll(".prospect-table thead th");
    const labels = ["Entreprise", "Verdict", "Signal principal", "Offre recommandée", "Opportunité"];
    labels.forEach((label, index) => {
      if (headers[index]) headers[index].textContent = label;
    });

    const visible = getCommercialVisibleItems();
    const rows = [...dom.results.querySelectorAll("tr")];
    rows.forEach((row, index) => {
      const item = visible[index];
      if (!item) return;
      const intelligence = item.commercialIntelligence || deriveCommercialIntelligence(item);
      const cells = row.querySelectorAll("td");
      if (cells.length < 6) return;

      row.dataset.verdict = intelligence.verdict;
      setCellContent(
        cells[1],
        intelligence.verdictLabel,
        `Confiance ${intelligence.confidence}/100`,
        VERDICTS[intelligence.verdict].className
      );
      setCellContent(
        cells[2],
        intelligence.primarySignal,
        item.website ? new URL(item.website).hostname.replace(/^www\./, "") : "Site officiel non confirmé"
      );
      setCellContent(
        cells[3],
        intelligence.primaryOffer,
        intelligence.priceRange
      );
      setCellContent(
        cells[4],
        `${intelligence.opportunityScore}/100`,
        intelligence.verdict === "verify" ? "Score limité par l’incertitude" : "priorité commerciale"
      );

      const button = cells[5].querySelector("button");
      if (button) button.textContent = "Ouvrir l’analyse";
    });

    const contactNow = state.items.filter(
      (item) => item.commercialIntelligence?.verdict === "contact_now"
    ).length;
    dom.summaryHigh.textContent = String(contactNow);
  }

  function ensureCommercialSection() {
    const dialogBody = document.querySelector("#prospect-dialog .dialog-body");
    if (!dialogBody) return null;

    let section = document.querySelector("#commercial-intelligence-section");
    if (section) return section;

    section = document.createElement("section");
    section.id = "commercial-intelligence-section";
    section.className = "dialog-section commercial-intelligence-section";
    section.setAttribute("aria-labelledby", "commercial-intelligence-title");
    section.innerHTML = `
      <div class="section-heading compact">
        <div>
          <p class="eyebrow">Décision commerciale</p>
          <h3 id="commercial-intelligence-title">Que vendre et pourquoi</h3>
        </div>
        <span class="status-badge pending" id="commercial-verdict">À vérifier</span>
      </div>
      <div class="commercial-overview">
        <article><span>Opportunité</span><strong id="commercial-score">—</strong></article>
        <article><span>Confiance</span><strong id="commercial-confidence">—</strong></article>
        <article><span>Budget conseillé</span><strong id="commercial-price">—</strong></article>
      </div>
      <div class="commercial-recommendation">
        <div>
          <span>Signal principal</span>
          <strong id="commercial-signal">Qualification nécessaire</strong>
        </div>
        <div>
          <span>Offre recommandée</span>
          <strong id="commercial-offer">Diagnostic numérique ciblé</strong>
        </div>
      </div>
      <div class="commercial-columns">
        <div>
          <h4>Signaux détectés</h4>
          <ul id="commercial-signals"></ul>
        </div>
        <div>
          <h4>Preuves vérifiables</h4>
          <ul id="commercial-evidence"></ul>
        </div>
      </div>
      <div class="commercial-confidence-grid" id="commercial-confidence-grid"></div>
      <button class="button button-secondary" id="copy-commercial-brief" type="button">Copier le brief commercial</button>
    `;

    dialogBody.prepend(section);
    section.querySelector("#copy-commercial-brief").addEventListener("click", async () => {
      const item = selectedProspect();
      if (!item) return;
      try {
        await navigator.clipboard.writeText(createCommercialBrief(item));
        showNotice("Brief commercial copié.", "success");
      } catch {
        showNotice("Impossible de copier automatiquement le brief.", "warning");
      }
    });

    return section;
  }

  function fillList(element, values, fallback) {
    element.replaceChildren();
    const items = values.length ? values : [fallback];
    for (const value of items) {
      const listItem = document.createElement("li");
      listItem.textContent = value;
      element.append(listItem);
    }
  }

  function syncCommercialSection(item) {
    const section = ensureCommercialSection();
    if (!section) return;
    const intelligence = item.commercialIntelligence || deriveCommercialIntelligence(item);
    const verdict = section.querySelector("#commercial-verdict");
    verdict.className = `status-badge ${VERDICTS[intelligence.verdict].className}`;
    verdict.textContent = intelligence.verdictLabel;
    section.querySelector("#commercial-score").textContent = `${intelligence.opportunityScore}/100`;
    section.querySelector("#commercial-confidence").textContent = `${intelligence.confidence}/100`;
    section.querySelector("#commercial-price").textContent = intelligence.priceRange;
    section.querySelector("#commercial-signal").textContent = intelligence.primarySignal;
    section.querySelector("#commercial-offer").textContent = intelligence.primaryOffer;
    fillList(section.querySelector("#commercial-signals"), intelligence.signals, "Aucun signal confirmé");
    fillList(section.querySelector("#commercial-evidence"), intelligence.evidence.slice(0, 6), "Preuves complémentaires nécessaires");

    const confidenceGrid = section.querySelector("#commercial-confidence-grid");
    confidenceGrid.replaceChildren(
      createMetric("Identité du site", `${intelligence.confidenceDetails.identity}/100`),
      createMetric("Besoin numérique", `${intelligence.confidenceDetails.need}/100`),
      createMetric("Capacité d’achat", `${intelligence.confidenceDetails.buying}/100`)
    );
  }

  updatePriority = function updatePriorityWithCommercialIntelligence(item) {
    ORIGINAL_UPDATE_PRIORITY(item);
    item.commercialIntelligence = deriveCommercialIntelligence(item);
    item.message = createActionableMessage(item);
  };

  getVisibleItems = getCommercialVisibleItems;

  render = function renderCommercialIntelligence() {
    ORIGINAL_RENDER();
    ensureFilterOptions();
    enhanceRenderedTable();
  };

  syncDialog = function syncDialogWithCommercialIntelligence() {
    ORIGINAL_SYNC_DIALOG();
    const item = selectedProspect();
    if (!item) return;
    if (!item.commercialIntelligence) updatePriority(item);
    syncCommercialSection(item);
    dom.contactMessage.value = item.message || "";
  };

  ensureFilterOptions();
  for (const item of state.items) updatePriority(item);
  persistItems();
  render();
})();
