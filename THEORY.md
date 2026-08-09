# Theory: Hermes namespace routing needs compatible identity headers

Hermes requests carry three different facts. `X-Hermes-Session-Id` selects the Hermes adapter and scopes its session. `X-Engram-Namespace` selects the caller namespace for MCP requests. REST routes use an explicit `namespace` field instead of adapter defaults.

Issue #2310 also requires an explicit namespace in `X-Engram-Client-Id`. The plugin sends that header for compatibility. It keeps `client_id` as the canonical config field and accepts `namespace` as an alias. A non-empty `client_id` wins. The parser rejects non-string values.

The Python client sends a configured value in both namespace headers. It adds the value to REST bodies and query parameters unless a call supplies another namespace. When no value is configured, the request omits its namespace and uses the daemon default. The legacy client identifier remains `"hermes"`. The provider keeps the Hermes session header current after a session switch.

The regression follows each route. Parser tests cover precedence and invalid values. Client tests cover headers, session updates, and REST defaults. A real provider transport test covers health and recall requests. Version 1.0.6 makes the merged code publishable because the release job skips versions already on PyPI.
