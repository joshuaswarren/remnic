---
"@remnic/core": patch
"@remnic/cli": patch
---

Config-time namespace-policy lint in `remnic doctor` (issue #1888 improvement 3). When a configured write namespace is writable by no one — namespace enforcement is on, and it is neither the `defaultNamespace` nor a `namespacePolicies` entry that grants a writer — every write to it is rejected by the namespace ACL and dead-lettered rather than stored. `doctor` now surfaces this as a "Namespace policy" warning with remediation (and a failed check when the configured `namespace` value is invalid), catching the misconfiguration at config time before a session silently loses memory. Backed by a new principal-agnostic `isNamespacePolicyCovered(namespace, config)` helper exported from `@remnic/core` that mirrors `canWriteNamespace` semantics (namespaces-off ⇒ all writable; `sharedNamespace` is not implicitly writable).
