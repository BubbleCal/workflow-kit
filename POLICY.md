# Independent instance policy

Policy version: portable-0.1.0. Read instance.json and this policy on every coordinator run.

This instance owns only scope.project_id and scope.project_root. Discover chats through supported native tools and verify actual user scope before enrollment. A matching title alone is insufficient. Do not scan unrelated project histories, account-wide sources, another computer's task state or unconfigured Slack/Notion/Linear sources. Source references are discovery evidence, not implementation authorization.

The coordinator is the sole runtime writer of registry.json and decisions.json. The inbox handles actual human input and shows decisions, requested answers and important completion only. Workers retain task scope, artifacts, branch ownership, live jobs and native permissions. The dispatcher performs bounded idle-only delivery. Maintenance owns workflow code improvements but queues operational mirrors through the coordinator.

For operation kinds dispatch/create_thread/assign_project/archive/unarchive, the control guard requires fresh native evidence with operation_project_verified=true and operation_project_id equal to this instance project ID. Every existing authorization, actual-owner and no-conflict condition still applies. Never relabel another project's evidence to satisfy the guard.

External comments, replies, reviews, approval submissions and reviewer requests are forbidden. External delivery features are disabled by default. Enable only explicitly authorized features in instance.json, with verified repository allowlist and relevant identity/destination. Disabled features mean use local artifacts and the instance inbox; they are not permission blockers requiring repetitive user questions. Slack, if enabled, allows only the configured canonical PR URL operation. Notion, if enabled, is confined to the configured page and preserved manual content. Automatic merge, if enabled, requires the configured approver's actual approval on the current head, required CI and repository rules.

New review delivery and draft-to-ready transitions are deferred every day in Asia/Shanghai [04:00,12:00). Development, tests, repairs and internal review continue. Review actions use prepare, claim, then authorize_review_send immediately before the external operation. A claim alone is insufficient. Preserve deferred records and recheck current head/readiness/receipts after noon. Unknown outcomes are never blind-retried. Do not create another timer or alternate communication channel.

Use durable goal/stage records and concrete successors before ACKing stage results. Never mark a whole task complete just because a turn ended or a child PR merged. Preserve explicit holds and current jobs. Only archive execution chats after whole-task acceptance, saved deliverables, completed delivery and cleanup. Do not archive control or ongoing service roles.

The task-count limits are null/unlimited; real resources, user scope and one owner per worktree still govern admission. Preserve the user's selected models and permissions. Centralize any explicit model choice in instance.json models; do not silently pick a weaker or stronger model. No routine progress spam. Chinese prose and English table contents are the default.

Validate proportionately and follow applicable repository requirements. Reuse valid evidence for the same code/environment. Benchmarks must represent the authorized product workload. Protect actual stable contracts and production consumers; do not add speculative compatibility layers for unreleased iterations. No repeated preparation-only rounds, redundant benchmarks, suppressed checks or invented performance gains.

The installation request authorizes the specifically requested role/schedule setup, not arbitrary new user-visible work chats. Later new chats still require an explicit user request. Reuse original execution owners and respect existing task drivers.
