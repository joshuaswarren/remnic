# Security policy

## Supported versions

Remnic ships from a single rolling release line. Security fixes land on the
latest published version; there are no long-term-support branches for older
releases.

| Version | Supported |
|---------|-----------|
| 9.6.x (latest) | Yes |
| < 9.6 | Upgrade to the latest release |

Always report against, and reproduce on, the latest published version.

## Reporting a vulnerability

Please do not open public issues for suspected vulnerabilities.

Use GitHub Security Advisories for private disclosure:
- https://github.com/joshuaswarren/remnic/security/advisories/new

If private advisory submission is unavailable, open an issue with minimal
details and request secure follow-up.

## Scope

This project handles memory extraction/indexing data and provider credentials.
Security-sensitive areas include:

- Provider/API configuration and credential handling
- Memory storage and retrieval paths
- Tool execution and external model/provider integration
- CI/CD and release automation

The adaptive-extraction threat model for the memory access surface is
documented in
[docs/security/memory-extraction-threat-model.md](docs/security/memory-extraction-threat-model.md).

## Responsible disclosure expectations

- Provide a clear reproduction path and impact assessment.
- Allow maintainers reasonable time to investigate and fix before public
  disclosure.
- Avoid accessing or exposing any real user/private data.

## Hard requirements for contributors

- Never commit secrets/tokens.
- Never include personal/private memory data in fixtures, tests, or docs.
- Redact logs before sharing.

## Network feature safety

Network sync and WebDAV surfaces are security-sensitive and must remain strict
opt-in.

- Default posture: disabled/not running unless explicitly invoked.
- WebDAV exposure must be constrained to explicit allowlist roots only.
- WebDAV should remain loopback-bound (`127.0.0.1`) by default.
- If auth is used, require a non-empty username + password together.
- Reject traversal and symlink escape attempts outside allowlisted roots.
- Do not add automatic public exposure behavior (for example, funnel/public
  listeners) as default behavior.

Operational recommendation:
- Prefer private-network transport (for example, Tailscale) when syncing
  memory across hosts.
