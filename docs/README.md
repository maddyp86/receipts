# docs

| Path | What it is |
| --- | --- |
| `RECONCILIATION.md` | The durable record of what was decided and why. Read it before trusting any spec. |
| `trace-log.md` | The per-run query trace: what each gate was given and what it decided. |
| `migrations/` | `supabase-schema.sql` (the base schema) and every numbered migration, `supabase-migration-0NN-*.sql`. New migrations go here, with the next unused number. |
| `queries/` | Read-only SQL run by hand against the live database (e.g. `beta-review.sql`). |
| `specs/` | Specs, proposals and thread hand-offs, including the rate-limiting spec, the PostHog and schema proposals, and the post-beta list. |
| `v2/` | The v2 rebuild: plan, phase prompts and reports, the n8n pipeline, and check queries. Start with `v2/README.md`. |
| `fix/` | The v1 alignment fix set, in apply order (`00_README_apply_order.md`). Historical. |
| `adr/` | Architecture decision records. |
| `eval/` | Eval cases (`cases.json`). |
