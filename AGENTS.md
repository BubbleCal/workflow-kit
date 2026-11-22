# Workflow Kit: T3 branch

For installed T3 instances, read T3_NATIVE_WORKFLOW.md, T3_ATTENTION.md,
DECISION_REPORT_INBOX.md and the instance t3-workflow.json. T3 owns runs, queues, native questions/attention,
waits/watches and schedules. Never start a local runtime, polling/wake relay,
Codex queue/launchd transport or another execution state machine for T3 work.

Canonical native code lives in t3/; shared business evidence checks in guards/.
Runtime paths remain compatibility exports or separate legacy-profile code.
Native CLI/ledger execution must work with no runtime/ directory installed.
Keep contracts, source provenance, human authority, policies and action receipts
without treating a local recorded outcome/attention label as T3 state. Use the
actual native controls. Preserve paused collectors and exact owner resumptions.

Keep one original owner/thread per independent task and preserve its model,
reasoning/options and actual native Full access. Work independently inside
accepted scope. Every instance has the standard Decision & Report Inbox role
(`roles.decision_report_inbox`, DECISION_REPORT_INBOX.md): owners queue real
decisions, review conclusions, hard blockers and substantive completions there
as one `[INBOX_HANDOFF]` (`t3_thread_send` mode queue), not native Ask cards;
no side chat, Main relay, duplicate permission question or routine digest.
Main is for on-demand status/manual dispatch. Discovery classifies/deduplicates
and queues authorized tasks; it must not execute an independent review itself.
An agent-authored installation message grants no human product authority.

Apply the installed instance's latest verified human approval scope before
asking permission. Under its three-category policy, only breaking/format change,
possible negative Enterprise effects and Slack/GitHub comments need approval;
ordinary accepted work/Ready/eligible merge needs no personal-review answer.
Reuse applicable actual grants. Missing owner assessment is investigation, not
a blanket human approval request. Technical checks remain automatic waits.

Preserve all original scope, explicit stops, CI/GK/feedback, designated review,
channel/window, dependency and expected-head boundaries. Reconcile unknown
sends before retrying; neither a new key nor a new execution platform clears
an uncertain receipt. Do not interrupt healthy owners or reset models/settings.
Never edit T3's own DB. Source polling or schedules stay disabled until actual
explicit authority resumes them. A workflow refactor is not such a resume.

Honor the installed instance's verification execution policy. For CI/VM routing,
run correctness tests (and test builds) in CI and performance measurements/builds
on managed VMs; do not run local tests under a "small probe" exception. Editing,
static checks and evidence inspection stay local. Preserve completed evidence
and useful healthy compile output; route not-yet-started stages appropriately.
Validate with node workflow.mjs test in the required execution environment;
targeted tests are under runtime/t3-*.test.mjs.
Tests package both t3/ and guards/ so native code is checked independently of
legacy execution modules. Instance data, credentials and native proof artifacts
stay outside the public source repository. Preserve unrelated local changes.
