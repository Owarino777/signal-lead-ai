import test from "node:test";
import assert from "node:assert/strict";

import {
  isDirectoryHost,
  scorePlaceMatch,
  scoreWebsiteIdentity
} from "../src/scoring.js";

const business = {
  name: "HEIKO",
  commercialName: "HEIKO",
  city: "Caen",
  address: "13 quai François Mitterrand 14000 Caen",
  phone: "02 50 53 12 46"
};

test("accepts the official website when name and city match", () => {
  const result = scoreWebsiteIdentity({
    business,
    url: "https://heiko-poke.com/caen/",
    title: "Heiko à Caen - Poké Bowl",
    description: "Restaurant Heiko au 13 quai François Mitterrand à Caen.",
    text: "Heiko Caen 13 quai François Mitterrand 02 50 53 12 46 Commander"
  });

  assert.equal(result.accepted, true);
  assert.ok(result.score >= 0.62);
});

test("rejects an unrelated domain containing a similar word", () => {
  const result = scoreWebsiteIdentity({
    business,
    url: "https://heiko.fr/",
    title: "Impression 3D et rubans",
    description: "Solutions techniques pour l'industrie.",
    text: "Impression 3D rubans email industrie Paris"
  });

  assert.equal(result.accepted, false);
});

test("rejects directories and social networks", () => {
  assert.equal(isDirectoryHost("www.facebook.com"), true);
  assert.equal(isDirectoryHost("pagesjaunes.fr"), true);

  const result = scoreWebsiteIdentity({
    business,
    url: "https://www.facebook.com/heikocaen",
    title: "Heiko Caen",
    description: "Restaurant à Caen",
    text: "Heiko Caen"
  });

  assert.equal(result.accepted, false);
});

test("accepts a nearby OpenStreetMap place with a matching name", () => {
  const result = scorePlaceMatch({
    business,
    place: {
      name: "Heiko Caen",
      address: "13 quai François Mitterrand 14000 Caen",
      website: "https://heiko-poke.com/caen/"
    },
    distanceKm: 0.08
  });

  assert.equal(result.accepted, true);
  assert.ok(result.score >= 0.56);
});
