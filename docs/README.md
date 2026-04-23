# GuardScan API — Documentation Index

Authoritative entry points:

- **[status.md](./status.md)** — current state: shipped milestones, catalog numbers, API surface, known limitations. Start here.
- **[../README.md](../README.md)** — quickstart, scripts, deployment, architecture overview.
- **[../CLAUDE.md](../CLAUDE.md)** — codebase conventions for AI-assisted work.

## Reference

| Doc | Purpose |
|---|---|
| [api/endpoints.md](./api/endpoints.md) | All shipped HTTP routes + their handlers |
| [architecture/image-storage-cdn.md](./architecture/image-storage-cdn.md) | Image storage CDN fix — public bucket proposal |
| [architecture/scoring.md](./architecture/scoring.md) | Scoring methodology v1.2.0 (subtract-only) |
| [architecture/scoring-v1.2-subtract-only-report.md](./architecture/scoring-v1.2-subtract-only-report.md) | v1.2.0 investigation report |
| [architecture/scoring-calibration-protocol.md](./architecture/scoring-calibration-protocol.md) | Score calibration protocol |
| [architecture/security.md](./architecture/security.md) | Security audit trail, env-var checklist, open findings |
| [ocr-confidence-tuning.md](./ocr-confidence-tuning.md) | OCR auto-publish threshold analysis |
| [testing/submission-flow-production.md](./testing/submission-flow-production.md) | Submission e2e runbook |
| [marketing/ingredient-science-brief.md](./marketing/ingredient-science-brief.md) | Ingredient science messaging brief |

## Historical milestone plans

The following are the implementation plans written *before* each milestone shipped. They're retained as design rationale, not as the current source of truth. For the current state of any shipped feature, read the code and [status.md](./status.md) first.

| Doc | Milestone | State |
|---|---|---|
| [milestones/m1.5-multi-source-scanning.md](./milestones/m1.5-multi-source-scanning.md) | M1.5 — OBF + DSLD adapters | shipped |
| [milestones/m2-cron-ingest.md](./milestones/m2-cron-ingest.md) | M2 — OBF / DSLD cron ingest | shipped |
| [milestones/m2.5-recommendations-api.md](./milestones/m2.5-recommendations-api.md) | M2.5 — Recommendations + alternatives | shipped |
| [milestones/m3-user-submissions.md](./milestones/m3-user-submissions.md) | M3.0 / M3.1 — Submissions + OCR | shipped |
| [milestones/m3.2-admin-dashboard.md](./milestones/m3.2-admin-dashboard.md) | M3.2 — Admin web dashboard | shipped |

## Forward-looking / deferred

| Doc | Purpose |
|---|---|
| [post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) | Why supplement scoring is deferred and what shipping it requires |
| [post-mvp/ingredient-enrichment.md](./post-mvp/ingredient-enrichment.md) | Rich ingredient detail pages — schema, data sourcing, and implementation plan |
| [multi-brand-migration.md](./multi-brand-migration.md) | Sketch for the Pomenatal (second brand) onboarding refactor |

## Navigating

- Need to understand the **current state** of the system → [status.md](./status.md)
- Need an **HTTP route reference** → [api/endpoints.md](./api/endpoints.md)
- Need to understand **why a product got a score** → [architecture/scoring.md](./architecture/scoring.md)
- Need to **review security posture** or add a new route safely → [architecture/security.md](./architecture/security.md)
- Need to **test the submission pipeline end-to-end** → [testing/submission-flow-production.md](./testing/submission-flow-production.md)
