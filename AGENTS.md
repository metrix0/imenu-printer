# iMenu Impressora — repository rules

## Branch and release
- This repository is `metrix0/imenu-printer`.
- **Commit changes directly to `main`.** This is an explicit exception to the `preview` rule for `metrix0/imenu`.
- Do not use `preview`, create a branch, or open a pull request for printer changes unless the user explicitly requests it.
- Read the current `main` files before editing and again before committing. Preserve concurrent changes and create one final commit per task.
- Pushing to `main` starts the existing Windows build, version increment, release, and downstream synchronization workflow. Let that automation run; do not manually trigger builds or publish releases unless explicitly requested.

## Scope and compatibility
- Make only the requested changes. Investigation-only requests are read-only.
- Preserve existing printer selections, login, receipt settings, layout, and workflows unless the requested change requires otherwise.
- Never automatically retry output that may already have reached the printer.
- Run `node --test printer-reliability.test.cjs` and relevant syntax checks before committing. Clearly distinguish simulated checks from real hardware printing.
- Follow `metrix0/imenu`'s applicable safety and design guidance, except for its repository-specific branch rule. Do not use RDC or Vercel without existing applicable authorization or explicit user permission.

