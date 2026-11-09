import assert from "node:assert/strict";
import test from "node:test";
import { cardGroupVisible, cardImageCollapse, cardModelVisible, setCardGroupVisible, setAllImageSummariesVisible, setCardModelVisible } from "../../src/app/(dashboard)/dashboard/quota/quotaCardDisplay.mjs";

test("legacy preferences read without mutation and preserve image override", () => {
  const old = { sharedRows: { weekly: false }, codex: { hidden: ["session"] } };
  const before = structuredClone(old), legacy = { all: true, overrides: { a: false } };
  assert.equal(cardGroupVisible(old, "a", "summary", legacy), true);
  assert.equal(cardGroupVisible(old, "a", "text", legacy), false);
  assert.equal(cardGroupVisible(old, "a", "images", legacy), true);
  assert.equal(cardGroupVisible(old, "b", "images", legacy), false);
  assert.equal(cardModelVisible(old, "codex", "images", "gpt-image"), false);
  assert.deepEqual(old, before);
});

test("group visibility is independent and hiding restores selected children", () => {
  let prefs = setCardModelVisible({}, { id: "a", provider: "codex", group: "text", model: "gpt-5", visible: true });
  prefs = setCardGroupVisible(prefs, "a", "text", false);
  assert.equal(cardGroupVisible(prefs, "a", "text"), false);
  assert.equal(cardGroupVisible(prefs, "a", "summary"), true);
  assert.equal(cardModelVisible(prefs, "codex", "text", "gpt-5"), true);
  prefs = setCardGroupVisible(prefs, "a", "text", true);
  assert.equal(cardModelVisible(prefs, "codex", "text", "gpt-5"), true);
});

test("shared exact model choice reveals only requesting parent; all hidden remains recoverable", () => {
  let prefs = { sharedRows: { weekly: false }, codex: { hidden: ["session"] } };
  for (const group of ["summary", "text", "images"]) prefs = setCardGroupVisible(prefs, "a", group, false);
  prefs = setCardModelVisible(prefs, { id: "a", provider: "codex", group: "text", model: "gpt-5", visible: true });
  assert.equal(cardGroupVisible(prefs, "a", "text"), true);
  assert.equal(cardGroupVisible(prefs, "b", "text"), false);
  assert.equal(cardGroupVisible(prefs, "a", "images"), false);
  assert.equal(cardModelVisible(prefs, "codex", "text", "gpt-5"), true);
  assert.equal(cardModelVisible(prefs, "other", "text", "gpt-5"), false);
  assert.equal(cardModelVisible(prefs, "codex", "text", "gpt-5-mini"), false);
  prefs = setCardModelVisible(prefs, { id: "a", provider: "codex", group: "text", model: "gpt-5", visible: false });
  assert.equal(cardGroupVisible(prefs, "a", "text"), true);
  assert.deepEqual(prefs.sharedRows, { weekly: false });
  assert.deepEqual(prefs.codex, { hidden: ["session"] });
});

test("global image control preserves children and other groups, per-card override follows", () => {
  let prefs = setCardModelVisible({}, { id: "a", provider: "codex", group: "images", model: "image-1", visible: true });
  prefs = setAllImageSummariesVisible(prefs, false);
  prefs = setCardGroupVisible(prefs, "a", "images", true);
  assert.deepEqual(cardImageCollapse(prefs), { all: true, overrides: { a: false } });
  assert.equal(cardGroupVisible(prefs, "b", "images"), false);
  assert.equal(cardModelVisible(prefs, "codex", "images", "image-1"), true);
  prefs = setAllImageSummariesVisible(prefs, true);
  assert.deepEqual(cardImageCollapse(prefs), { all: false, overrides: {} });
  assert.equal(cardModelVisible(prefs, "codex", "images", "image-1"), true);
});
