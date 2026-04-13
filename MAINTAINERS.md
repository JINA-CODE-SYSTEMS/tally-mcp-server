# Maintainers

## Current Maintainers

| Name | GitHub | Role |
|------|--------|------|
| Tapan Jain | [@jain-t](https://github.com/jain-t) | Lead maintainer |

**Organization:** [Jinacode Systems](https://github.com/JINA-CODE-SYSTEMS)

## Original Author

This project was originally created by [Dhananjay Gokhale](https://github.com/dhananjay1405/tally-mcp-server).

## Responsibilities

Maintainers are responsible for:

- Reviewing and merging pull requests
- Triaging issues
- Managing releases and deployments
- Ensuring security of the codebase
- Maintaining CI/CD pipelines

## Deployment

The production instance is deployed automatically via GitHub Actions on push to `main`:

- **Self-hosted runner** on Windows GCloud VM
- **NSSM service** (`TallyMCP`) manages the Node.js process
- **Caddy** reverse proxy handles HTTPS termination

See `.github/workflows/deploy.yml` for the full pipeline.

## Becoming a Maintainer

Active contributors who demonstrate sustained, quality contributions may be invited to become maintainers. Open an issue or reach out to the current maintainers if interested.
