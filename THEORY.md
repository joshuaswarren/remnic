# Theory: Hermes transport must make cleartext an explicit remote choice

The Hermes client sends bearer tokens with each daemon request. It sends session identifiers only when configured. Remote cleartext can expose these values. Therefore, remote connections use TLS by default. Loopback connections keep HTTP for local use.

The Hermes adapter selects its runtime URLs. A host-neutral core helper classifies loopback names and IP addresses. Both runtime and installer probes use HTTP for loopback hosts. They use HTTPS for remote hosts unless the operator enables the compatibility option.

The Python config parser accepts booleans and common boolean strings. Missing values default to `false`. It rejects numeric and unknown values. The client constructor requires a boolean. The provider forwards the parsed value without reinterpretation.

Tests cover loopback names, trailing DNS dots, IPv4, IPv6, mapped IPv4, remote hosts, explicit opt-in, and invalid values. Package checks and the repository preflight verify the change. Version 1.0.7 makes the fix publishable.
