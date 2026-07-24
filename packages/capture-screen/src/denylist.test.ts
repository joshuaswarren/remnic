import assert from "node:assert/strict";
import { test } from "node:test";

import { globToRegExp, matchDenyRule, matchesAnyGlob } from "./denylist.js";

const EMPTY = { apps: [], titles: [], urls: [] };

test("built-in secret-manager apps are denied and name the rule", () => {
  assert.equal(matchDenyRule({ app: "1Password 7", windowTitle: "Vault" }, EMPTY), "app:1Password*");
  assert.equal(matchDenyRule({ app: "Bitwarden", windowTitle: "x" }, EMPTY), "app:Bitwarden*");
  assert.equal(matchDenyRule({ app: "KeePassXC", windowTitle: "x" }, EMPTY), "app:KeePass*");
});

test("built-in private-browsing titles are denied", () => {
  assert.equal(
    matchDenyRule({ app: "Safari", windowTitle: "Example (Private Browsing)" }, EMPTY),
    "title:*private browsing*",
  );
  assert.equal(matchDenyRule({ app: "Chrome", windowTitle: "Docs - Incognito" }, EMPTY), "title:*incognito*");
});

test("user app / title / url globs are additive", () => {
  assert.equal(
    matchDenyRule({ app: "SecretApp", windowTitle: "x" }, { apps: ["SecretApp"], titles: [], urls: [] }),
    "app:SecretApp",
  );
  assert.equal(
    matchDenyRule({ app: "Safari", windowTitle: "Online Banking" }, { apps: [], titles: ["*banking*"], urls: [] }),
    "title:*banking*",
  );
  assert.equal(
    matchDenyRule(
      { app: "Safari", windowTitle: "Bank", browserUrl: "https://secure.bank.example/login" },
      { apps: [], titles: [], urls: ["*bank.example*"] },
    ),
    "url:*bank.example*",
  );
});

test("a clean window matches no rule", () => {
  assert.equal(matchDenyRule({ app: "Terminal", windowTitle: "zsh", browserUrl: null }, EMPTY), null);
});

test("globs match case-insensitively and anchor the whole value", () => {
  assert.ok(globToRegExp("1Password*").test("1password 8"));
  assert.ok(matchesAnyGlob(["*.internal"], "host.internal"));
  assert.equal(matchesAnyGlob(["Terminal"], "Terminal Pro"), false, "anchored: no substring match");
});
