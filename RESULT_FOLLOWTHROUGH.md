# Result followthrough

Accepted research, benchmarks, assessments and implementation owners report
substantive results through `node workflow.mjs task op` (`op: report`). This uses
the ordinary catalog and native runtime. No research conversation becomes a
coordinator. Discovery performs bounded intake and owner setup under its existing
global minimum interval; original owners retain implementation and delivery.

## Authority and scope

The optional `accept_result_followups` policy must reference an actual human
instruction authorizing bounded downstream implementation/testing and independent
owner creation. Source documents, benchmark output and model recommendations are
evidence only. Preserve assessment-only/review-only limits, implementation holds,
paused owners, dependencies and repository scope. Deployment, publication,
external messages and changes to another owner's PR need their original separate
authority. Material choices become durable inbox decisions; ordinary cases do not
need a human relay. Do not create a new coordinator, timer or polling agent.

## Owner report

Submit while the original owner's native wake is running. Include `task_id`,
`owner_thread_id`, stable `report_key`, `outcome` (`findings`,
`no_actionable_findings`, `inconclusive`), `summary`, `evidence_refs` and `followups`.
Repeated identical reports are read-only; changed content requires a new key.
No-finding/inconclusive reports cannot manufacture implementation work.

Each followup contains:

- `canonical_key`, `problem`, `evidence_refs`, `evidence_limits`,
  `expected_benefit`, `reason` and `disposition`.
- `disposition`: `implement`, `existing`, `decision`, `blocked` or `no_action`.
  Implementation/existing requires `actions`, a nonempty subset of
  `implementation`, `testing`, `benchmark`. State measurement limits honestly;
  expected benefit is a hypothesis until validated.
- For new work, `task` contains concrete `title`, `objective`, `workspace`,
  `requirements: [{id,text}]`, `constraints`, optional existing `depends_on` IDs
  and a complete `difficulty_assessment` under MODEL_SELECTION.md, including
  scoped `target_repositories` and `repository_evidence_ref`.
- For existing work, `existing_task_id` must match the canonical identity. New
  findings route once to that original owner. If the finding is already explicitly
  covered and assigned, set `disposition: existing` plus
  `existing_work_evidence_ref` (also in `evidence_refs`). This reconciles original
  execution receipts without resending work; never use it to claim a new finding
  was consumed by an old unrelated turn.
- Set `requires_additional_authority: true` for a material new choice or goal.
  Persist the decision rather than admitting or starting it.

Followups are independent tasks with origin provenance, not unfinished child goals
of a finite assessment. Complete the original assessment using its own acceptance;
followups do not reopen it. Legacy `proposals` remain candidates and confer no
implementation authority.

## Existing discovery and native owner setup

The runtime persists reviews/followups and includes fixed keys in the next existing
discovery batch. `discovery begin` returns `result_followthrough` alongside source
coverage. Source failures do not prevent result handling. Do only the fixed keys:

1. Read a pending review's original owner's actual terminal result with native
   `read_thread`. The declared local thread, workspace and exact turn must match.
   Submit `task report` with its `review_key` and fresh
   `native_proof: {source:"codex_app.read_thread",checked_at,readback,evidence_ref}`.
   Preserve the full genuine tool envelope. If the owner is still running or the
   result cannot be read, checkpoint that exact blocker; do not invent findings.
2. Query `task result_followups`. The runtime derives admission and durable owner
   requests. For accepted `needs_owner` work, obtain a fresh native project catalog
   and call `task prepare_owner` with `task_id`, `projects`,
   `project_catalog_ref`, `checked_at`.
3. Use the returned exact control key/evidence with existing prepare/claim/settle,
   invoke native creation only once, confirm actual project placement, then
   `bind_owner`. Preserve centralized model choices and native permissions.
   Reconcile uncertain creation; retry only proven non-delivery through existing
   bounded backoff, using the same task/action. Never create a replacement owner.
4. `task start` follows existing queue compatibility/dependency/pause guards.
   Runtime advancement also starts eligible bound work. Verify `execution_started`,
   `actual_wake_id` and `actual_turn_id`, then inspect meaningful native progress.
   Admission, owner reservation and queue ACK are not execution.
5. `discovery finish` requires completed fixed result work, or a concrete
   `result_followups_reason`. This reason and fixed keys persist on checkpoint.
   Keep the existing 15-minute minimum across scans and checkpoint retries.

`important_completion` notifications attributed to the actual original owner may
carry `payload.result_report` in the same schema. Otherwise completion requests a
narrow result review. Notification delivery remains subject to existing inbox
rules; recording a result does not send a message.

## Named catchup

Do not scan arbitrary completed history. For a specifically authorized missed
result, call `task review_result` with `task_id`, `source_message_id`,
`actual_human_verified: true`, `evidence_ref`, then use the original terminal proof
and report protocol above. Existing T208 followups T213/T214 are reconciliation
cases: preserve their bindings and actual started wakes; do not recreate/resend.

When discovery_owns_creation is enabled, daemon advancement leaves new-owner setup to discovery, using creation_actor proof at prepare/claim/bind/start under OWNER_CREATION.md. Existing canonical owners keep ordinary result routing; no main creation or parallel setup path.


Follow OWNER_CONTINUATION.md: a phase report or negative experiment does not
complete an authorized unfinished goal. Continue bounded independent work, retain
actual jobs/waits, and request only a material human-only decision. Conditional
holds use their original wording and observable release predicate; unconditional
pauses and all external-action gates remain. Record remaining goal and next step.
