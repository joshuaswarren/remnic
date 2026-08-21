import assert from "node:assert/strict";
import { test } from "node:test";

import { extractAxText, SECURE_ROLE, type AxNode } from "./axtree.js";

const tree: AxNode = {
  role: "AXWindow",
  title: "Login",
  children: [
    { role: "AXStaticText", value: "Username" },
    { role: "AXTextField", value: "alice@example.com" },
    { role: "AXStaticText", value: "Password" },
    { role: SECURE_ROLE, value: "hunter2-should-never-appear", children: [{ role: "AXStaticText", value: "leak?" }] },
    { role: "AXGroup", offScreen: true, children: [{ role: "AXStaticText", value: "offscreen-should-not-appear" }] },
    { role: "AXButton", description: "Sign In" },
  ],
};

test("extracts visible text from value/title/description across the tree", () => {
  const { text } = extractAxText(tree, 4000);
  assert.match(text, /Login/);
  assert.match(text, /Username/);
  assert.match(text, /alice@example\.com/);
  assert.match(text, /Sign In/);
});

test("AXSecureTextField text and its subtree are never extracted", () => {
  const { text } = extractAxText(tree, 4000);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /leak/);
});

test("off-screen nodes and their subtree are excluded", () => {
  const { text } = extractAxText(tree, 4000);
  assert.doesNotMatch(text, /offscreen-should-not-appear/);
});

test("traversal is bounded by maxNodes and flags truncation", () => {
  const wide: AxNode = { role: "AXWindow", children: Array.from({ length: 50 }, (_, i) => ({ value: `n${i}` })) };
  const capped = extractAxText(wide, 10);
  assert.equal(capped.nodes, 10);
  assert.equal(capped.truncated, true);
  const full = extractAxText(wide, 4000);
  assert.equal(full.truncated, false);
  assert.equal(full.nodes, 51);
});

test("document order is preserved in the extracted text", () => {
  const { text } = extractAxText(tree, 4000);
  assert.ok(text.indexOf("Username") < text.indexOf("Password"), "children read in order");
});
