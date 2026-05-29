# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in super-agent, please report it **privately**. Do not open a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/FedericoCasarella/super-agent/security/advisories/new) (Security → Report a vulnerability), or
- Contact the maintainer directly via the email on their [GitHub profile](https://github.com/FedericoCasarella).

Please include: a description of the issue, steps to reproduce, the affected component, and the potential impact. We'll acknowledge your report and keep you updated on the fix.

## Scope

super-agent is **self-hosted**: you run it on your own infrastructure, with your own database and credentials. The most security-sensitive surfaces are:

- **Connector credentials** — stored in the database (`connectors` table), never in the repo. Keep your database access controlled.
- **The Telegram link flow** — chat binding requires a one-time code generated server-side, not the first `/start` that arrives.
- **The Claude Code runner** — executes with your local environment; treat the host as trusted infrastructure.
- **Human-in-the-loop approvals** — actions with real-world side effects (sending email, spawning agents) are proposed for explicit approval, not auto-executed.

## Good practices when self-hosting

- Never commit `.env` or credentials. Rotate any secret that may have been exposed.
- Restrict network access to the backend (`localhost` / private network) unless you've added auth in front of it.
- Keep dependencies current (`npm audit`).
