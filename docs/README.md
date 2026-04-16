# GuardScan API — Documentation Index

Authoritative entry points:

- **[status.md](./status.md)** — current milestone status, environment surface, DB coverage, known limitations. Start here.
- **[mvp-sprint-plan.md](./mvp-sprint-plan.md)** — the live sprint plan (rev 4). Source of truth for what's actively being worked on.
- **[../README.md](../README.md)** — quickstart, scripts, deployment, architecture overview.
- **[../CLAUDE.md](../CLAUDE.md)** — codebase conventions for AI-assisted work.

## Reference

| Doc | Purpose |
|---|---|
| [api/endpoints.md](./api/endpoints.md) | All shipped HTTP routes + their handlers |
| [architecture/scoring.md](./architecture/scoring.md) | Full scoring methodology (food / grooming / supplement) |
| [architecture/security.md](./architecture/security.md) | Security audit trail, env-var checklist, open findings, best practices |
| [testing/submission-flow-production.md](./testing/submission-flow-production.md) | Runbook: end-to-end submission test against production |

## Historical milestone plans

The following are the implementation plans written *before* each milestone shipped. They're retained as design rationale, not as the current source of truth. For the current state of any shipped feature, read the code and [status.md](./status.md) first.

| Doc | Milestone | State |
|---|---|---|
| [milestones/m1.5-multi-source-scanning.md](./milestones/m1.5-multi-source-scanning.md) | M1.5 — OBF + DSLD adapters | shipped |
| [milestones/m2-cron-ingest.md](./milestones/m2-cron-ingest.md) | M2 — OBF / DSLD cron ingest | shipped |
| [milestones/m2.5-recommendations-api.md](./milestones/m2.5-recommendations-api.md) | M2.5 — Recommendations + alternatives | shipped |
| [milestones/m3-user-submissions.md](./milestones/m3-user-submissions.md) | M3.0 / M3.1 — Submissions + OCR | shipped |

## Forward-looking / deferred

| Doc | Purpose |
|---|---|
| [post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) | Why supplement scoring is deferred and what shipping it requires |
| [post-mvp/ingredient-enrichment.md](./post-mvp/ingredient-enrichment.md) | Rich ingredient detail pages — schema, data sourcing, and implementation plan |
| [multi-brand-migration.md](./multi-brand-migration.md) | Sketch for the Pomenatal (second brand) onboarding refactor |

## Navigating

- Need to understand the **current state** of the system → [status.md](./status.md)
- Need to know what's **being built this sprint** → [mvp-sprint-plan.md](./mvp-sprint-plan.md)
- Need an **HTTP route reference** → [api/endpoints.md](./api/endpoints.md)
- Need to understand **why a product got a score** → [architecture/scoring.md](./architecture/scoring.md)
- Need to **review security posture** or add a new route safely → [architecture/security.md](./architecture/security.md)
- Need to **test the submission pipeline end-to-end** → [testing/submission-flow-production.md](./testing/submission-flow-production.md)
