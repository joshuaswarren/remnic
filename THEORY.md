# Theory: Hermes namespace routing needs compatible identity headers

Hermes requests carry three different facts. `X-Hermes-Session-Id` selects the Hermes adapter and scopes its session. `X-Engram-Namespace` selects the caller namespace for MCP requests. REST routes use an explicit `namespace` field instead of adapter defaults.

Issue #2310 also requires an explicit namespace in `X-Engram-Client-Id`. The plugin sends that header for compatibility. It keeps `client_id` as the canonical config field and accepts `namespace` as an alias. A non-empty `client_id` wins. The parser rejects non-string values.

The Python client sends `client_id` in `X-Engram-Client-Id` and `namespace` in `X-Engram-Namespace`. The provider sets both from the selected config namespace. The client adds `namespace` to REST bodies and query parameters when a call does not supply a non-null override. Daemon namespace identifiers allow at most 256 printable ASCII characters without edge spaces. The client rejects unsupported values before transport. When no namespace is configured, requests use the daemon default. The legacy client identifier remains `"hermes"`. Session changes update the HTTP client before the provider publishes its new state.

The regression follows each route. Parser tests cover precedence, session trimming, and invalid values. Client tests cover headers, session updates, REST defaults, null overrides, daemon limits, and transport-safe identifiers. A real provider transport test covers health and recall requests. Version 1.0.6 makes the merged code publishable because the release job skips versions already on PyPI.
