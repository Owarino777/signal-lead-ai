"use strict";

// Keep the public API request compatible with the documented default response.
// The API returns all secondary fields by default; `include` is only valid with `minimal=true`.
const nativeFetch = window.fetch.bind(window);

window.fetch = (input, init) => {
  try {
    const sourceUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const url = new URL(sourceUrl, window.location.href);

    if (
      url.origin === "https://recherche-entreprises.api.gouv.fr" &&
      url.pathname === "/near_point"
    ) {
      url.searchParams.delete("include");
      const normalizedInput = input instanceof Request ? new Request(url.href, input) : url.href;
      return nativeFetch(normalizedInput, init);
    }
  } catch {
    // Fall through to the native request when the input cannot be normalized.
  }

  return nativeFetch(input, init);
};
