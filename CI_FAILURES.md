# Individual CI failures and owner follow-through

A draft PR or an overall workflow still running can already have a failed job.
Observe individual current-head checks and statuses during existing PR follow-up;
never wait for the entire run to finish before triaging an observed failure.

The read-only runtime/fetch-pr-state.mjs collector now reads all latest check-run
pages and combined-status pages for the exact current head, then verifies PR
identity/state did not change during collection. Closed/merged PRs do not need
CI reads before their own follow-through. It preserves an incomplete read
as an error, not an empty/successful feed. It writes snapshot.ci with head_sha,
checked_at, evidence_ref, complete=true and checks. Every check has kind
(check_run/status), id, name, head_sha, status, conclusion, completed_at and url.
The observed feed does not establish which checks are required or grant merge
permission. Determine required/optional status from actual repository rules and
validation contracts during triage; optional cancellation is not automatically a
code defect or permission to rerun anything. GitHub Actions job failures are
visible independently of the suite/workflow aggregate.

The lifecycle checks new failures before draft/readiness/feedback transitions.
An incomplete, stale or mixed-head CI snapshot creates refresh_ci. A metadata or
feedback-only read on the same head retains the existing CI observation without
refreshing its timestamp; a new head cannot inherit its failures. Poll times,
file paths and draft changes do not create new failure identities. Actual source
job/status IDs, conclusions and completion times identify changed failures.

For triage_ci, read exact failing logs and classify each as related code-fixable,
unrelated code-fixable, infrastructure, already broken on main, flaky, legitimate
external dependency wait, optional/nonblocking, or unknown. Match original task,
head, owner and any queued/running/uncertain repair before further dispatch.
Reconcile changed review feedback together with the repair scope. Do not send a
second message to a healthy active owner, replace it, blindly retry deterministic
failures, weaken required checks, or request reviewer actions.

Before lifecycle_resolve(disposition=progress), record_progress(ack=false) for
that EXACT lifecycle event and source task. Save a concrete repair successor,
actual running repair evidence, or a verified typed wait. An unavailable official
Maven/package release needs an owning-source dependency fact, its exact artifact
requirement and expiry/resume condition. A release tag alone is not proof all
language packages were published. Preserve the existing release owner/path and
healthy jobs. Use existing available read-only capabilities for triage; do not
change native permissions or introduce a probe-only execution phase.

An accepted task-bound triage disposition resolves only that exact failure set.
It does not finish the task or declare CI green. Unchanged failures do not generate
another repair loop; the durable successor and existing wait-fact expiry drive
follow-through. A new failed attempt/source result or head creates new triage.
Review feedback and readiness may proceed after triage where authorized; after
review delivery, unchanged handled failures remain ci_disposition_recorded until
CI facts change. Required current-head CI, full feedback, approval and native
expected-head merge rules still apply. No new scheduler or external side effect
is performed by collection or the lifecycle planner.

Sources: https://docs.github.com/en/rest/checks/runs and
https://docs.github.com/en/rest/commits/statuses
