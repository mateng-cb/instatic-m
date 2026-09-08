# Security Policy

Instatic-M is a self-hosted fork and not recommended for hostile multi-user environments without careful operator review. Security reports are still taken seriously.

## Supported Versions

Security fixes target the latest `main` branch and the latest tagged release.

## Reporting A Vulnerability

Use GitHub's private vulnerability reporting for this repository:

```txt
https://github.com/mateng-cb/instatic-m/security/advisories/new
```

If private vulnerability reporting is unavailable, open a minimal public issue asking for a private reporting channel. Do not include exploit details, secret material, vulnerable URLs, or proof-of-concept payloads in that public issue.

Helpful reports include:

- affected version, commit, or Docker image tag
- deployment mode, for example SQLite Compose, Postgres Compose, or GitHub Pages static export
- clear reproduction steps
- impact and expected attacker capabilities
- any relevant logs with secrets redacted

## Scope

In scope:

- authentication, authorization, session, MFA, and CSRF issues
- plugin sandbox escapes or permission bypasses
- server-side request forgery or unsafe network access
- path traversal, unsafe upload handling, or published-output injection
- secret leakage from logs, exports, bundles, or admin APIs

Out of scope:

- local developer database contents
- reports requiring full server owner access without a privilege boundary bypass
- denial-of-service reports that only exhaust intentionally limited local resources without a realistic public deployment path

Maintainers will acknowledge valid private reports, triage impact, and coordinate fixes before public disclosure.
