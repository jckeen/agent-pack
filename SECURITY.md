# Security Policy

## Supported versions

| Version | Supported           |
|---------|---------------------|
| 0.1.x   | :white_check_mark: |

This project is at v0.1 and the security model is still evolving. The MVP build closed an initial set of findings (path traversal via `atom.path`, hook command injection, MCP shell-escape, prototype pollution). See [`docs/security.md`](./docs/security.md) for the current threat model.

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Instead:

1. Open a private GitHub Security Advisory on this repository: Settings → Security → Advisories → "Report a vulnerability".
2. Include:
   - The affected file(s) and code path.
   - A reproduction (the smallest pack manifest that demonstrates the issue is ideal).
   - Your assessment of severity and impact.

We aim to respond within 5 business days and ship a fix within 30 days for high/critical findings.

## Out-of-scope

- Vulnerabilities in dependencies — please report those upstream and link the advisory here.
- Issues in your own un-published packs that you exclusively own.
- Theoretical concerns without a working proof-of-concept against the current `main` branch.

## Hall of fame

Once we ship a stable release, we'll credit security contributors here.
