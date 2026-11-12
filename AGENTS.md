# Workflow Kit: T3 branch

This branch contains a T3-native profile alongside the original Codex runtime.
For an existing T3 installation, read `T3_NATIVE_WORKFLOW.md` and
`T3_ATTENTION.md`, then its separate `t3-workflow.json`. Do not run legacy
`init`, `runtime init`, launchd installation or native Codex queue setup on it.
Use `t3 ledger` for task/decision records and T3 native tools for execution.
The original runtime is still available for its existing independent instances.

Preserve the selected provider/model/options and effective native permissions.
Keep one original execution owner per task. Reuse stable task/case/request IDs.
Act independently inside accepted scope: investigate, implement, test, repair
routine failures and try justified alternatives without repeated permission
questions. Escalate actual goal changes, missing authority or a demonstrated
blocker, with context and a recommendation. Continue useful independent work.

Use T3's native queue to deliver a separate next turn without steering a healthy
experiment. A native receipt, actual run execution, business acceptance and
human attention are distinct. Reconcile unknown sends before retrying. Snooze
defers attention; Settled grants no approval and does not mean product complete.
Never write T3's own database or infer human authority from agent-authored text.

Installation does not silently move existing Codex tasks or enable duplicate
source collectors. Keep old owners/jobs/holds and explicit scope until their
handoff is recorded. Do not create a periodic trigger relay or arbitrary
per-cycle target cap. Prefer native schedules bound to the responsible thread.

Validate code with `node workflow.mjs test`; targeted T3 tests are under
`runtime/t3-*.test.mjs`. Instance state, credentials and native proof artifacts
stay outside the public source repository.
