"use strict";

(function activateVerifiedContactActions() {
  if (window.__SIGNAL_LEAD_CONTACT_ACTIONS__) return;
  window.__SIGNAL_LEAD_CONTACT_ACTIONS__ = true;

  if (typeof syncDialog !== "function" || typeof selectedProspect !== "function") return;

  const baseSyncDialog = syncDialog;

  function createElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function normalizePhoneLink(value) {
    const phone = String(value ?? "").trim();
    if (!phone) return null;
    const normalized = phone.replace(/[^+\d]/g, "");
    return normalized.length >= 8 ? `tel:${normalized}` : null;
  }

  function normalizeEmailLink(value) {
    const email = String(value ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
    return `mailto:${email}`;
  }

  function normalizeExternalUrl(value) {
    if (!value) return null;
    try {
      const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function createAction(label, href, icon, external = false) {
    const link = createElement("a", "sl-contact-action");
    link.href = href;
    link.append(
      createElement("span", "sl-contact-action-icon", icon),
      createElement("span", "", label)
    );
    if (external) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    return link;
  }

  function getSocialLinks(item) {
    return (Array.isArray(item.social) ? item.social : [])
      .map(normalizeExternalUrl)
      .filter(Boolean)
      .slice(0, 2);
  }

  function renderContactCard(item) {
    const decision = document.querySelector("#commercial-intelligence-section");
    if (!decision) return;

    decision.querySelector(".sl-contact-card")?.remove();

    const phoneHref = normalizePhoneLink(item.phone);
    const emailHref = normalizeEmailLink(item.email);
    const siteHref = normalizeExternalUrl(item.website);
    const socialLinks = getSocialLinks(item);
    const hasContact = Boolean(phoneHref || emailHref || siteHref || socialLinks.length);

    const card = createElement("section", "sl-contact-card");
    card.setAttribute("aria-labelledby", "sl-contact-card-title");

    const heading = createElement("div", "sl-contact-card-heading");
    const headingCopy = createElement("div", "");
    headingCopy.append(
      createElement("span", "sl-contact-card-label", "Coordonnées publiques"),
      createElement("h4", "sl-contact-card-title", hasContact ? "Contacter l’entreprise" : "Coordonnées à compléter")
    );
    headingCopy.querySelector("h4").id = "sl-contact-card-title";
    heading.append(headingCopy);

    const actions = createElement("div", "sl-contact-actions");
    if (phoneHref) actions.append(createAction("Appeler", phoneHref, "☎"));
    if (emailHref) actions.append(createAction("E-mail", emailHref, "✉"));
    if (siteHref) actions.append(createAction("Ouvrir le site", siteHref, "↗", true));
    socialLinks.forEach((url, index) => {
      actions.append(createAction(`Réseau ${index + 1}`, url, "↗", true));
    });

    if (!hasContact) {
      actions.append(createElement(
        "p",
        "sl-contact-empty",
        "Aucune coordonnée fiable n’a encore été trouvée. Qualifie d’abord le site officiel."
      ));
    }

    card.append(heading, actions);

    const actionBar = decision.querySelector(".sl-action-bar");
    const proofs = decision.querySelector(".sl-proof-details");
    if (actionBar) actionBar.insertAdjacentElement("afterend", card);
    else if (proofs) proofs.insertAdjacentElement("beforebegin", card);
    else decision.append(card);
  }

  syncDialog = function syncDialogWithVerifiedContacts() {
    baseSyncDialog();
    const item = selectedProspect();
    if (item) renderContactCard(item);
  };
})();
