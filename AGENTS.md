## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Ticket implementation

Implement ticket sets with `/implement-tickets` (or ask for "these tickets" by name): it works the
frontier one ticket at a time, each in a fresh subagent context, updating the todos and the ticket
file between tickets. A single ticket goes through `/skill:implement` directly.

Status vocabulary in ticket files: `ready-for-agent` → `in-progress` → `done`. Flip the status as
you work. A ticket left at `ready-for-agent` after its commit landed blocks its successors and makes
the frontier lie.

### Triage labels

Five canonical triage roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

Refer to `RUNBOOK.md` to start, restart, stop server
