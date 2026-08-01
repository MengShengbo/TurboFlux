# Architecture decision records

Architecture decision records (ADRs) capture cross-module constraints that must
remain understandable over time. They explain why a direction was chosen and
what consequences follow; they do not replace implementation documentation or
task plans.

## Status values

- `proposed`: under discussion.
- `accepted`: the current implementation must follow it.
- `superseded`: replaced by another ADR but retained for history.
- `deprecated`: no longer applicable.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-runtime-composition-root.md) | Agent Runtime as the composition root | accepted |

## Adding an ADR

1. Copy [`0000-template.md`](0000-template.md).
2. Use the next four-digit number and a short kebab-case filename.
3. Describe context, decision, alternatives, consequences, implementation, and verification.
4. Review it before or with the implementation pull request.
5. Update this index and affected architecture pages.

Use an ADR for persistence schemas, cross-layer event contracts, state ownership,
process boundaries, public APIs, capability/approval boundaries, or provider
compatibility. Local renames, ordinary bug fixes, and reversible details do not
need an ADR.
