# Theory: Hermes transport must make cleartext an explicit remote choice

The Hermes client carries bearer tokens and session identifiers on every daemon request. Cleartext HTTP is suitable only for loopback traffic by default. A remote daemon needs TLS unless its operator explicitly accepts cleartext compatibility.

URL selection belongs in the Hermes adapter. The core daemon stays host-neutral. The client classifies `localhost`, `.localhost` names, IPv4 loopback, IPv6 loopback, and IPv4-mapped loopback as local. It brackets IPv6 literals before it builds URLs. Every other host uses HTTPS. The `allow_insecure_http` config option is the only remote HTTP opt-in.

The config parser accepts real booleans and common boolean strings. It rejects missing, numeric, and unknown values. The client constructor also requires a real boolean, so direct callers cannot enable cleartext with Python truthiness. The provider forwards the parsed value without reinterpretation.

Tests cover loopback names without case sensitivity, trailing DNS dots, IPv4, IPv6, mapped IPv4, remote hostnames, remote IP addresses, explicit opt-in, and invalid values. Package tests, Ruff, mypy, distribution builds, Twine checks, and the repository preflight verify the change. Version 1.0.7 makes the fix publishable.
