# Keeping custom changes compatible with official 9Router

The production fork remains ordinary 9Router source plus committed changes. Use
Git commits and standard patches, not copied deployment folders or runtime edits,
as the source of truth. `patches/upstream.json` pins the verified official base
and records feature dependencies and regression entry points.

## Current boundaries

- Official base: `decolua/9router`, v0.5.116,
  `1339107e624d1ab150c6a0c2c2ee22caa7e9db2f`.
- The initial integration commit `bc01ed87` changes 299 files. It preserves the
  custom features but **is not a collection of independent upstream PRs**.
  Catalogue entries marked `extract-from-integration` still need focused extraction.
- Codex automatic reset is a later dependent feature. Its UI, dispatch admission,
  consent, durable reset ledger and recovery tests must travel together.
- The production workflow, restricted deployment receiver and environment setup
  are fork-specific. Never include them in an unrelated official feature PR.
- Some legacy integration names remain in the source. Their presence does not make
  an external application a runtime dependency; evaluate each before upstreaming.

## For every new change

1. Branch from the maintained fork. Keep one operator problem per commit or small
   coherent series; keep tests with the behavior they prove. Do not rewrite deployed
   history. Fixes to earlier features may be squashed on a separate PR branch.
2. Reuse official helpers, route contracts, UI components and extension points.
   Prefer a small shared hook to duplicating a provider executor or replacing a
   whole official file. Avoid speculative plugin frameworks and patch-on-startup.
3. Keep generic behavior separate from provider-specific capability checks. Missing
   quota data is not zero; Codex consent/reset credits must not leak to other scopes.
   Preserve disabled-default settings, existing users' data and error recovery.
4. Add or update the relevant catalogue entry. List dependencies honestly; shared
   files do not prove two features are independent. Record migration dependencies
   and renumber pending migrations against the target branch before merging.
5. Run the feature tests and patch replay check. Runtime changes also require the
   existing full CI/build and safe deployment gates. Never spend credits or make
   provider requests merely to prove that a patch applies.

## Export a reproducible patch set

From the repository root, choose a **new** output directory outside the repo:

```sh
python3 scripts/patches/export.py --verify --output /tmp/9router-patch-export
```

This exports only committed changes from the pinned official base to `HEAD`:
numbered email patches, a complete binary-safe diff, and `series.json` containing
commit IDs and SHA-256 checksums. It replays each patch using a private index and
compares the final tree to `HEAD`. Unsaved changes, the real index, branches and
production are untouched. Existing output directories are rejected. Partial failed
exports have no verified manifest and must not be used. Merge-containing ranges are
rejected; prepare a linear integration branch rather than silently dropping merges.

On a clean checkout at the recorded base, use `git am` on the numbered patches in
`series.json` order, **or** `git apply --index complete.patch`; do not apply both.
The complete export is a fork-recovery artifact, not the default upstream PR payload.
Replay success proves source reproduction only, not behavior or compatibility with
a newer release.

## Upgrade to a newer official release

1. Fetch official source into the official remote. Record the target commit/version;
   do not equate a moving branch name with a verified release.
2. Create an isolated upgrade branch/worktree. Keep production `master` and its
   automatic deployment unchanged until checks pass. Never merge private application
   histories, rollout archives or deployment transcripts into the public source.
3. Compare each custom feature with the new official implementation. Drop patches
   already accepted or superseded upstream; port still-needed behavior through its
   current helpers. Resolve conflicts semantically, never by taking whole custom files.
4. For the bundled legacy integration, extract reviewed feature slices against the
   new base; do not claim a path-filtered diff is independently buildable. Replay
   dependent migrations, repository changes, dispatch callers and UI together.
5. Run feature regressions, full tests/build, representative real-browser checks and
   isolated migration/restart checks. Preserve unknown image outcomes, recorded
   reset times, consent and actual accepted requests. Old DB snapshots are not a
   safe rollback after traffic has resumed.
6. Update the pinned base and catalogue only after the port is verified. Keep the
   old patch export and release receipt. Export/replay the new linear series before
   fast-forwarding production `master`; its normal CI/CD remains the deployment gate.

## Prepare an official PR when a feature is ready

Start a fresh branch at the then-current official target. Extract one useful feature
and its necessary foundations, with no fork deployment or local documentation data.
If a dependency is still pending, use a clearly stated stacked PR or wait; do not
hide it in an unrelated patch. A small independent bug fix should go first.

Lead the PR with the operator problem and observable result, then include:

- Real browser before/after screenshots with the exact source revision, theme,
  viewport and observed state. Synthetic fixture images must be labelled as such.
  Redact account identifiers and secrets; do not stage success as production evidence.
- One short concept diagram only when it clarifies selection, quota admission or
  recovery. Distinguish measured behavior from intended behavior.
- Focused regression results, migration/backward-compatibility notes and remaining
  limitations. Use familiar official terminology and concise prose.

Preparing a patch or PR draft does not authorize submission to the official repo.
Do not submit, comment, alter an existing official PR or publish screenshots without
the owner's instruction.

## Relative quota and observed capacity

Plan percentages describe headroom within that account's reported allowance. A
Free monthly 100% and a Plus weekly 100% are not equal token budgets. Preserve
reported plan, scope and duration; authentication claims are a separately labelled
fallback. Never infer a fixed token limit or multiply by API prices.

`quotaCapacity.mjs` learns passively from successful, provider-metered requests
between two quota reads. It rejects plan/identity/reset changes, overlapping or
mixed requests, incomplete/estimated usage, intervals over an hour and changes
under five percentage points. Samples retain separate uncached input, cached
input and output counts, with bounded seven-day retention in existing snapshots.
No prompt, completion, credential or extra provider request is added.

The optional Observed capacity sort uses a conservative similar-request range
after five intervals, 25 quota points and ten requests per applicable allowance.
Cross-account sorting requires matching requested speed/effort and request token
components within 1.5x. Otherwise the rule is skipped; existing sorts/fallback
remain. This range is an empirical extrapolation, not a confidence interval,
token budget or guarantee. External use and hidden provider accounting remain
unobserved. It cannot clear quota waits, grant model access or redeem resets.

## Automatic refill-time ordering and compact card sections

`auto-reset` is an optional shared criterion, labelled Reset time with an Auto
badge. It is unrelated to reset-credit spending. Within fresh requested-model
allowance scope, exhausted constraints use their latest reset (all must recover);
if any exhausted deadline is unknown the value is unknown. Otherwise the next
known refill is used. Unknown values trail in both directions. Actual periods,
including monthly plans, are retained without converting percentages into tokens.
A timestamp is ordering evidence, never confirmation of recovery or permission
to retry a held job. Existing admission, model access and reset consent remain.

Saved explicit short/weekly sorts are not migrated or silently published. They
remain active and editable; inactive explicit windows are in Add sort. The normal
card list merges display partitions into Ready/Unavailable (or one flat list with
availability grouping off). It preserves ranking within each section and keeps
explicit routing divisions and their decision trace in the rotation preview.
No DB migration or new dependency is required.
