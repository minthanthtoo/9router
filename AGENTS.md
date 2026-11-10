# Maintaining this 9Router fork

Read `docs/PATCH_MAINTENANCE.md` before non-trivial custom changes or upgrades.
`patches/upstream.json` records the official base and feature dependencies.

Keep official source architecture and small traceable feature commits. New feature
or behavior changes must update their catalogue entry and tests. Do not overwrite
official files wholesale or copy private Hualogu/AuriX histories into this repo.
Fork deployment code is not part of an official feature PR. Preserve deployed Git
history; extract/squash upstream PRs only on separate branches.

Before delivery, run the focused tests and export/replay the committed patch series.
That proves source reproducibility, not runtime compatibility with future versions.
Never submit an official PR without explicit user instruction. Changes on `master`
automatically deploy; use a separate branch for compatibility exploration.
