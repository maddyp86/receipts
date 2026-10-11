# Receipts v2

The rebuild of the record pipeline on Supabase. Start with `plan.md`.

| File | What it is |
|---|---|
| `plan.md` | The design, the phases, and the gates each phase has to pass |
| `phase-1-prompt.md` | The prompt that starts Phase 1 in a new Claude Code session |
| `phase-2-prompt.md` | The prompt for Phase 2, the query tool. Use after gate G1 passes |
| `phase-3-prompt.md` | The prompt for Phase 3, the new pipeline. The cutover itself is done with Matt, from `plan.md` |
| `phase-1-report.md` | What Phase 1 loaded, row counts, the vector check, and the full G1 difference list |
| `g1-check.sql` | Gate G1 as a read-only query: `core.member_bill_actions` against the mirror, field by field |
| `reference/sources.md` | Every sheet, tab, column, file path, workflow id and index the old system uses |
| `reference/vote-slot-rules.md` | The tested rules for deriving a member's cloture and passage votes, with the five known sheet errors |
| `reference/ossoff-load-backup-2026-10-10.json` | Rows removed when the partial Jon Ossoff load was rolled back. For Phase 4 |

## What a Claude Code session needs before Phase 1

1. **This repo**, with these files on the branch it is working from.
2. **Connections:** Supabase (the account that holds the Receipts database, the one with schemas `mirror` and `app`), n8n, Google Sheets, GitHub.
3. **Two keys in the environment:** `PINECONE_API_KEY`, to copy stored vectors, and `OPENAI_API_KEY` with a few dollars of credit, for a five-bill embedding check.
4. **A database owner** for migration 014, which creates a schema and enables an extension. If the Supabase connection cannot apply migrations, run the file in the Supabase SQL editor.
5. **The n8n editor closed** whenever the session writes to n8n.
