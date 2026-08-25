import test from "node:test";
import assert from "node:assert/strict";
import {
  doesRuleMatch,
  isSafeRouteNamespace,
  isLikelyUnsafeRegex,
  selectRouteRule,
  validateRouteTarget,
  type RouteRule,
} from "@remnic/core/routing/engine";

function rule(overrides: Partial<RouteRule>): RouteRule {
  return {
    id: overrides.id ?? "r1",
    patternType: overrides.patternType ?? "keyword",
    pattern: overrides.pattern ?? "incident",
    priority: overrides.priority ?? 0,
    target: overrides.target ?? { category: "fact" },
    enabled: overrides.enabled,
  };
}

test("doesRuleMatch supports keyword matching", () => {
  assert.equal(
    doesRuleMatch(rule({ patternType: "keyword", pattern: "network outage" }), "We hit a Network Outage in prod"),
    true,
  );
});

test("doesRuleMatch supports regex matching", () => {
  assert.equal(
    doesRuleMatch(rule({ patternType: "regex", pattern: "outage\\s+in" }), "minor outage in us-east"),
    true,
  );
});

test("doesRuleMatch fail-opens for invalid regex", () => {
  assert.equal(
    doesRuleMatch(rule({ patternType: "regex", pattern: "(" }), "text"),
    false,
  );
});

test("doesRuleMatch reject grouped user regex patterns", () => {
  assert.equal(
    doesRuleMatch(rule({ patternType: "regex", pattern: "(alpha)+" }), "alpha alpha"),
    false,
  );
});

test("doesRuleMatch rejects adjacent quantifier regex patterns", () => {
  assert.equal(
    doesRuleMatch(rule({ patternType: "regex", pattern: "a+a+$" }), "a".repeat(2000) + "X"),
    false,
  );
});

test("doesRuleMatch ignores unsupported pattern types", () => {
  const invalidTypeRule = { ...rule({ patternType: "keyword", pattern: "incident" }), patternType: "glob" } as unknown as RouteRule;
  assert.equal(doesRuleMatch(invalidTypeRule, "incident occurred"), false);
});

test("doesRuleMatch fail-opens when pattern is not a string", () => {
  const malformedRule = { ...rule({ patternType: "keyword" }), pattern: null } as unknown as RouteRule;
  assert.equal(doesRuleMatch(malformedRule, "incident occurred"), false);
});

test("selectRouteRule uses priority order with stable tie-break", () => {
  const rules: RouteRule[] = [
    rule({ id: "low", priority: 1, pattern: "incident", target: { category: "fact" } }),
    rule({ id: "high", priority: 10, pattern: "incident", target: { category: "decision" } }),
    rule({ id: "high-2", priority: 10, pattern: "incident", target: { category: "moment" } }),
  ];

  const selected = selectRouteRule("incident occurred", rules);
  assert.ok(selected);
  assert.equal(selected.rule.id, "high");
  assert.equal(selected.target.category, "decision");
});

test("selectRouteRule skips invalid targets and continues", () => {
  const rules: RouteRule[] = [
    rule({ id: "bad", priority: 10, pattern: "incident", target: { namespace: "../unsafe" } }),
    rule({ id: "good", priority: 5, pattern: "incident", target: { namespace: "ops" } }),
  ];

  const selected = selectRouteRule("incident occurred", rules, { allowedNamespaces: ["ops"] });
  assert.ok(selected);
  assert.equal(selected.rule.id, "good");
  assert.equal(selected.target.namespace, "ops");
});

test("selectRouteRule skips malformed null targets", () => {
  const rules: RouteRule[] = [
    { ...rule({ id: "bad", priority: 10, pattern: "incident" }), target: null as unknown as RouteRule["target"] },
    rule({ id: "good", priority: 1, pattern: "incident", target: { category: "fact" } }),
  ];

  const selected = selectRouteRule("incident occurred", rules);
  assert.ok(selected);
  assert.equal(selected.rule.id, "good");
});

test("validateRouteTarget enforces allowed namespaces and categories", () => {
  const ok = validateRouteTarget(
    { category: "decision", namespace: "team-alpha" },
    { allowedNamespaces: ["team-alpha"], allowedCategories: ["decision", "fact"] },
  );
  assert.equal(ok.ok, true);

  const badCategory = validateRouteTarget({ category: "moment" }, { allowedCategories: ["fact"] });
  assert.equal(badCategory.ok, false);

  const badNamespace = validateRouteTarget({ namespace: "team-beta" }, { allowedNamespaces: ["team-alpha"] });
  assert.equal(badNamespace.ok, false);
});

test("isSafeRouteNamespace rejects traversal and path separators", () => {
  assert.equal(isSafeRouteNamespace("default"), true);
  assert.equal(isSafeRouteNamespace("team.alpha-1"), true);
  assert.equal(isSafeRouteNamespace("."), false);
  assert.equal(isSafeRouteNamespace("../default"), false);
  assert.equal(isSafeRouteNamespace("ops/team"), false);
  assert.equal(isSafeRouteNamespace("ops\\team"), false);
});

test("isLikelyUnsafeRegex flags high-risk constructs", () => {
  assert.equal(isLikelyUnsafeRegex("(a|aa)+$"), true);
  assert.equal(isLikelyUnsafeRegex("(\\w+)\\1"), true);
  assert.equal(isLikelyUnsafeRegex("a+a+$"), true);
  assert.equal(isLikelyUnsafeRegex("outage\\s+in"), false);
});
