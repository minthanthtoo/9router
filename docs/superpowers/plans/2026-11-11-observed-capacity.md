# Observed account capacity implementation plan

Goal: distinguish relative quota, plan identity and passively measured workload capacity without fixed plan multipliers.
Architecture: extend existing normalized snapshots with provenance and bounded interval samples. Reuse usageHistory metadata and existing sort evaluator, admission and preview/card owners. No provider generation, new dependencies or migration.
Spec: approved six-step plan in this conversation.

- [x] Record sanitized request start/speed/effort metadata through existing successful usage paths; test malformed values.
- [x] Pair quota refreshes with complete same-model workload intervals, rejecting resets/plan/identity changes, mixed workloads, uncertainty and small percentage changes. Bound samples and retention; test empty, overlap, rounded, stale and changed cases.
- [x] Estimate similar recorded requests with ranges only after five intervals/25 quota points/10 requests; expose evidence and components, never claim absolute tokens. Shared optional sort uses estimates for selected model, missing last. Preserve provider admission.
- [x] Add plan provenance/auth-mode context, actual period labels and percentage-only display. Compact estimate evidence in existing preview; no extra dashboard.
- [ ] Run regression suite, inspect diff, catalogue/docs update, commit and exact patch replay. Push fork master using existing production CI; verify health and live saved-data display. No paid calls/reset spending. Remove only unused rebuildable build caches.

Rulings: existing isolated worktree reused. Implement inline. Cross-account comparisons are empirical for similar recorded work, never API-dollar/token-budget conversion. Unobserved external usage remains an explicit confidence limitation. Unknown estimates cannot bypass quotas/holds.
