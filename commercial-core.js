"use strict";

(function activateCommercialCore() {
  if (window.__SIGNAL_LEAD_COMMERCIAL_CORE__) return;
  window.__SIGNAL_LEAD_COMMERCIAL_CORE__ = true;

  if (
    typeof updatePriority !== "function"
    || typeof getVisibleItems !== "function"
    || typeof render !== "function"
  ) {
    window.__SIGNAL_LEAD_COMMERCIAL_CORE__ = false;
    return;
  }

  const baseUpdatePriority = updatePriority;
  const baseRender = render;

  const verdictRanks = Object.freeze({
    contact_now: 5,
    secondary: 4,
    verify: 3,
    equipped: 2,
    low_fit: 1
  });

  const verdictLabels = Object.freeze({
    contact_now: "À contacter",
    secondary: "Opportunité ciblée",
    verify: "À qualifier",
    equipped: "Déjà bien équipé",
    low_fit: "À écarter"
  });

  const offers = Object.freeze({
    fastfood: Object.freeze({
      noSite: "Site de commande et visibilité locale",
      conversion: "Optimisation du parcours de commande",
      mobile: "Refonte mobile orientée conversion",
      seo: "Référencement local et pages établissement",
      trust: "Avis, preuves sociales et réassurance",
      structure: "Refonte technique et éditoriale",
      maintenance: "Maintenance et optimisation continue"
    }),
    restaurants: Object.freeze({
      noSite: "Site avec réservation, menu et visibilité locale",
      conversion: "Optimisation de la réservation en ligne",
      mobile: "Refonte mobile du parcours client",
      seo: "Référencement local du restaurant",
      trust: "Photos, avis et réassurance",
      structure: "Refonte technique et éditoriale",
      maintenance: "Maintenance et optimisation continue"
    }),
    food: Object.freeze({
      noSite: "Site avec commande, réservation et menu",
      conversion: "Optimisation de la commande ou réservation",
      mobile: "Refonte mobile orientée conversion",
      seo: "Référencement local",
      trust: "Photos, avis et réassurance",
      structure: "Refonte technique et éditoriale",
      maintenance: "Maintenance et optimisation continue"
    }),
    building: Object.freeze({
      noSite: "Site de génération de demandes de devis",
      conversion: "Optimisation du parcours de demande de devis",
      mobile: "Refonte mobile pour les demandes locales",
      seo: "Référencement local par métier et zone",
      trust: "Réalisations, certifications et avis",
      structure: "Refonte technique et contenus métiers",
      maintenance: "Maintenance et optimisation continue"
    })
  });

  function catalogFor(item) {
    return offers[item.segment] || offers.fastfood;
  }

  function metric(item, name) {
    const value = Number(item.audit?.metrics?.[name]);
    return Number.isFinite(value) ? value : null;
  }

  function unique(values, limit = 8) {
    return [...new Set(values.filter(Boolean))].slice(0, limit);
  }

  function hasManualIssue(item, issue) {
    return Array.isArray(item.manualIssues) && item.manualIssues.includes(issue);
  }

  function deriveSignals(item) {
    const catalog = catalogFor(item);
    const signals = [];
    const recommendations = [];
    const evidence = [];
    const mobile = metric(item, "mobile");
    const seo = metric(item, "seo");
    const structure = metric(item, "structure");
    const conversion = metric(item, "conversion");

    if (item.noSiteConfirmed) {
      signals.push("Aucun site officiel confirmé");
      recommendations.push(catalog.noSite);
      evidence.push("Absence de site confirmée manuellement");
    } else if (!item.website) {
      signals.push("Site officiel non confirmé");
      evidence.push("Aucun domaine suffisamment fiable n’a été validé");
    }

    if (mobile !== null && mobile < 65) {
      signals.push("Expérience mobile insuffisante");
      recommendations.push(catalog.mobile);
      evidence.push(`Score mobile : ${mobile}/100`);
    }

    if (conversion !== null && conversion < 58) {
      signals.push(item.segment === "building"
        ? "Demande de devis peu visible"
        : "Commande ou réservation peu visible");
      recommendations.push(catalog.conversion);
      evidence.push(`Score de conversion : ${conversion}/100`);
    }

    if (seo !== null && seo < 60) {
      signals.push("Référencement de base perfectible");
      recommendations.push(catalog.seo);
      evidence.push(`Score SEO : ${seo}/100`);
    }

    if (structure !== null && structure < 58) {
      signals.push("Structure technique perfectible");
      recommendations.push(catalog.structure);
      evidence.push(`Score de structure : ${structure}/100`);
    }

    if (hasManualIssue(item, "datedDesign")) {
      signals.push("Design visuellement daté");
      recommendations.push(catalog.structure);
      evidence.push("Contrôle visuel : design daté");
    }

    if (hasManualIssue(item, "poorMobile")) {
      signals.push("Affichage mobile peu convaincant");
      recommendations.push(catalog.mobile);
      evidence.push("Contrôle visuel : affichage mobile insuffisant");
    }

    if (hasManualIssue(item, "weakConversion")) {
      signals.push("Parcours commercial insuffisant");
      recommendations.push(catalog.conversion);
      evidence.push("Contrôle visuel : action commerciale peu visible");
    }

    if (hasManualIssue(item, "weakTrust")) {
      signals.push("Preuves de confiance insuffisantes");
      recommendations.push(catalog.trust);
      evidence.push("Contrôle visuel : manque de preuves ou d’avis");
    }

    if (hasManualIssue(item, "confusingNavigation")) {
      signals.push("Navigation difficile à comprendre");
      recommendations.push(catalog.structure);
      evidence.push("Contrôle visuel : navigation confuse");
    }

    for (const value of item.audit?.evidence || []) {
      evidence.push(sanitizeText(value, 260));
    }

    for (const value of item.businessEvidence || []) {
      evidence.push(sanitizeText(value, 260));
    }

    if (!recommendations.length && item.audit) {
      recommendations.push(catalog.maintenance);
    }

    return {
      signals: unique(signals, 6),
      recommendations: unique(recommendations, 5),
      evidence: unique(evidence, 10)
    };
  }

  function classify(item, derived) {
    const businessScore = item.businessScore ?? 0;
    const needScore = item.siteNeed?.score ?? null;
    const identityUncertain = !item.noSiteConfirmed && (
      !item.website
      || ["searching", "deferred", "enrichment_failed", "not_found"].includes(item.websiteDiscoveryStatus)
    );

    if (businessScore < 42) return "low_fit";
    if (identityUncertain || needScore === null) return "verify";

    if (hasManualIssue(item, "siteGood") && derived.signals.length === 0) {
      return "equipped";
    }

    if (businessScore >= 58 && needScore >= 62) return "contact_now";
    if (businessScore >= 50 && needScore >= 35) return "secondary";

    if (needScore < 35) {
      return derived.signals.length > 0 ? "secondary" : "equipped";
    }

    return "verify";
  }

  function identityConfidence(item) {
    if (item.noSiteConfirmed) return 95;
    if (!item.website) return item.websiteDiscoveryStatus === "not_found" ? 35 : 20;
    if (item.websiteSource === "Correction manuelle") return 98;
    if (Number.isFinite(item.websiteConfidence)) {
      return clamp(item.websiteConfidence * 100);
    }
    return item.audit ? 75 : 55;
  }

  function needConfidence(item) {
    if (item.noSiteConfirmed) return 92;
    if (item.audit && item.manualIssues?.length) return 94;
    if (item.audit) return 80;
    if (item.website) return 48;
    return 25;
  }

  function buyingConfidence(item) {
    let score = 40;
    if (item.revenue !== null) score += 18;
    if (item.employees !== null) score += 12;
    if (item.employer) score += 8;
    if (item.establishments >= 1 && item.establishments <= 5) score += 7;
    if (item.creationDate) score += 5;
    return clamp(score);
  }

  function priceRange(item, verdict) {
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

  function deriveCommercialIntelligence(item) {
    const derived = deriveSignals(item);
    const verdict = classify(item, derived);
    const identity = identityConfidence(item);
    const need = needConfidence(item);
    const buying = buyingConfidence(item);
    const confidence = clamp(identity * 0.34 + need * 0.38 + buying * 0.28);
    const rawPriority = item.finalPriority ?? clamp((item.businessScore ?? 0) * 0.45);
    const uncertaintyPenalty = verdict === "verify" ? 24 : verdict === "low_fit" ? 18 : 0;
    const opportunityScore = clamp(rawPriority - uncertaintyPenalty);
    const primarySignal = derived.signals[0]
      || (verdict === "equipped" ? "Site globalement satisfaisant" : "Qualification complémentaire nécessaire");

    return {
      verdict,
      verdictLabel: verdictLabels[verdict],
      opportunityScore,
      primarySignal,
      signals: derived.signals,
      recommendedOffers: derived.recommendations,
      primaryOffer: derived.recommendations[0] || "Diagnostic numérique ciblé",
      priceRange: priceRange(item, verdict),
      confidence,
      confidenceDetails: { identity, need, buying },
      evidence: derived.evidence
    };
  }

  function createCommercialMessage(item) {
    const intelligence = item.commercialIntelligence;
    const company = item.commercialName || item.name;
    const proof = intelligence.evidence
      .filter((value) => !/chiffre d’affaires non publié/i.test(value))
      .slice(0, 2);

    if (!["contact_now", "secondary"].includes(intelligence.verdict)) {
      return item.message || createMessage(item, item.service || "création et refonte de sites web");
    }

    const observation = proof.length
      ? `J’ai notamment relevé ${proof.join(" ainsi que ").toLowerCase()}.`
      : `J’ai identifié un axe d’amélioration concernant ${intelligence.primarySignal.toLowerCase()}.`;

    return [
      "Bonjour,",
      "",
      `Je me permets de vous contacter au sujet de ${company}.`,
      "",
      observation,
      "",
      `Je peux vous proposer une intervention ciblée de ${intelligence.primaryOffer.toLowerCase()} et vous transmettre un diagnostic court, sans engagement.`,
      "",
      "Seriez-vous disponible pour un échange de 15 minutes ?",
      "",
      "Bien cordialement,"
    ].join("\n");
  }

  function ensureFilterOptions() {
    const select = document.querySelector("#qualification-filter");
    if (!select) return;

    const currentValue = select.value;
    const options = [
      ["all", "Tous les prospects"],
      ["contact_now", "À contacter"],
      ["secondary", "Opportunités ciblées"],
      ["verify", "À qualifier"],
      ["equipped", "Déjà bien équipés"],
      ["low_fit", "À écarter"]
    ];

    if (!select.querySelector('option[value="contact_now"]')) {
      select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    }

    select.value = options.some(([value]) => value === currentValue) ? currentValue : "all";
  }

  function commercialVisibleItems() {
    const query = sanitizeText(dom.filter.value, 120).toLowerCase();
    const qualification = dom.qualificationFilter.value;
    const sort = dom.sort.value;

    const items = state.items.filter((item) => {
      const intelligence = item.commercialIntelligence || deriveCommercialIntelligence(item);
      const searchable = [
        item.name,
        item.commercialName,
        item.city,
        item.address,
        item.activityLabel,
        intelligence.primarySignal,
        intelligence.primaryOffer
      ].join(" ").toLowerCase();

      if (query && !searchable.includes(query)) return false;
      if (qualification !== "all" && intelligence.verdict !== qualification) return false;
      return true;
    });

    return items.sort((left, right) => {
      const leftIntelligence = left.commercialIntelligence || deriveCommercialIntelligence(left);
      const rightIntelligence = right.commercialIntelligence || deriveCommercialIntelligence(right);

      if (sort === "business") return right.businessScore - left.businessScore;
      if (sort === "site") return (right.siteNeed?.score ?? -1) - (left.siteNeed?.score ?? -1);
      if (sort === "revenue") return (right.revenue ?? -1) - (left.revenue ?? -1);
      if (sort === "name") {
        return (left.commercialName || left.name).localeCompare(right.commercialName || right.name, "fr");
      }

      return verdictRanks[rightIntelligence.verdict] - verdictRanks[leftIntelligence.verdict]
        || rightIntelligence.opportunityScore - leftIntelligence.opportunityScore
        || right.businessScore - left.businessScore;
    });
  }

  updatePriority = function updateCommercialPriority(item) {
    baseUpdatePriority(item);
    item.commercialIntelligence = deriveCommercialIntelligence(item);
    item.message = createCommercialMessage(item);
  };

  getVisibleItems = commercialVisibleItems;

  render = function renderCommercialCore() {
    baseRender();
    ensureFilterOptions();
    dom.summaryHigh.textContent = String(
      state.items.filter((item) => item.commercialIntelligence?.verdict === "contact_now").length
    );
  };

  for (const item of state.items) updatePriority(item);
  persistItems();
  render();
})();
