# Security

## Reporting vulnerabilities

Do not publish vulnerability details in a public issue. Contact the maintainers
through the private channel configured for the repository and include:

- affected version;
- reproduction steps;
- observed impact;
- a fix or mitigation, if available.

## Operating model

Matchday Control is designed for a trusted local network. Do not expose it
directly to the Internet without an additional network and access-control layer.

Each installation creates its own PIN and session secret. Protect the `data/`
folder, especially when OBS integration is enabled, because it contains the OBS
WebSocket password.
