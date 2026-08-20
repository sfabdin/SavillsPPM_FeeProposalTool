# Working agreement

## Ship by default

Work is not finished when it is committed. It is finished when it is on
`main` and a person can see it in the app.

Merging is part of doing the task, not a separate permission to ask for.
Do not leave a completed, tested change sitting on a branch waiting for a
nod — that reads as "done" from the outside while nothing has actually
changed for anyone.

Two exceptions, and only two:

- **Something is genuinely unresolved** — a failing test, a decision that
  is the user's to make, a risk worth naming. Then say so plainly at the
  TOP of the reply, in the first line, not buried under a summary of what
  was built.
- **The user asked to hold.**

If a change is built but not live for any other reason, that is a bug in
the process. Say **"built, not live"** in the first sentence.

### Before merging

- `main` has not moved under the branch (or rebase and re-verify if it has)
- the full suite passes on the exact tree being merged — `tests.html`, plus
  the browser checks for anything touched
- only intended files in the diff; no scratch harnesses (`_*.html`) leaked in

### After merging

Say where the change surfaces — which page, which tab — and whether it
needs a one-time action before it shows anything. A feature that renders
an empty state until someone runs a backfill looks broken if nobody says
so first.

## Reporting

State outcomes plainly. If tests failed, say so with the output. If a step
was skipped, say that. When something is done and verified, say it without
hedging. Never describe work as delivered when it is not deployed.
