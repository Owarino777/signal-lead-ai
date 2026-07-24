"use strict";

(function activateRuntimeFixes() {
  if (typeof syncDialog !== "function") return;

  const PREVIOUS_SYNC_DIALOG = syncDialog;

  syncDialog = function syncDialogWithStableCommercialSection() {
    const commercialSection = document.querySelector("#commercial-intelligence-section");

    if (commercialSection && !commercialSection.querySelector("#commercial-verdict")) {
      commercialSection.remove();
    }

    PREVIOUS_SYNC_DIALOG();
  };
})();
