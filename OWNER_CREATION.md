# Discovery-owned execution setup

When the human-authorized `discovery_owns_creation` work policy is enabled, main
registers and accepts tasks with their actual human source, scope, workspace and
acceptance. Main does not create, bind or initially start an execution owner.
Existing owners keep their identity, model, permissions, jobs and holds.
An explicit task-specific human model choice may be recorded as
`source.model_override` on the registered user task, with the existing
MODEL_SELECTION.md source/evidence/canonical identity fields. The setup helper
passes it to that centralized model guard; discovery must not invent overrides.

Main uses `task accept` with `start_requested:true` when the actual user asks to
start a new task immediately. For an already accepted ownerless task, use
`task request_creation` with task_id, actual_human_verified, source_message_id and
evidence_ref. This persists one human trigger and uses the existing runtime loop
and discovery chat. A pending/running discovery batch is never reentered or
rewritten. After it ends, the trigger may bypass the automatic scan interval
once; later retries retain the configured interval. Ordinary source scans and
automatic accepted-task setup keep that interval. No extra timer or coordinator.

## Immediate manual requests outside a source batch

An actual main-to-discovery relay for a new, accepted user task may acknowledge
its existing human start trigger without waiting for an unrelated pending scan.
It does not begin, rewrite, finish or acknowledge any source batch or queue.
Use `task begin_creation` with task_id, trigger_key, action_key,
source_message_id, evidence_ref, native_proof and human_authorization.

The action must be the existing sent main-owned human_input for discovery, with
its actual transport receipt. Its exact untruncated native incoming delegation
must be in the current active discovery turn. human_authorization is the original
`{source:"codex_app.read_thread",readback,evidence_ref}` envelope containing the
exact original human thread/turn/message/text. The accepted task's user source,
authorization, trigger and relay must agree, and the relay names the exact task ID
and canonical key. Main cannot become the creation actor. Another acknowledged
running discovery writer, an existing owner or an uncertain relay blocks setup.

On success the stable trigger is consumed once and the authenticated manual run
is saved. Pass `creation_actor={thread_id,trigger_key,native_proof}` to the normal
prepare_owner/claim/project/bind_owner/start operations, refreshing native proof
after 60 seconds. Do not mix batch_id/generation into that actor. Replaying the
same acknowledgement is idempotent; a different turn or changed scope is rejected.
Uncertain native creation retains the original action and its normal recovery
guards. Actual execution still requires the new original owner's native begin;
creation and queue acknowledgements do not establish execution. Automatic scans
and automatic setup retain their normal minimum interval.

The acknowledged discovery batch returns fixed `owner_creation` tasks even when
all external sources are disabled. Handle them before source-history pagination:

1. Read current task/scope and `task creation_pending`. Reuse the exact canonical
   owner request/action. Preserve uncertain, claimed and sent creation receipts.
   Candidates and drafts are never accepted by this path.
2. Obtain fresh actual `codex_app.read_thread` proof of this discovery run. Pass
   `creation_actor={thread_id,batch_id,generation,native_proof}` to request_owner,
   prepare_owner, bind_owner and first task start. The proof must match the current
   acknowledged native discovery turn and expires after 60 seconds. Refresh it
   after long tool calls. Main identity, another native turn and stale proofs fail.
3. Assess full-task difficulty and target repositories under MODEL_SELECTION.md;
   respect isolated-worktree, current-main, original branch and task-scope rules.
   Fetch fresh native projects and call task prepare_owner with projects,
   project_catalog_ref and checked_at. The helper derives creation authority from
   stored actual human rules and preserves original task acceptance separately.
   Discovery text and source observations grant no new authority.
4. Claim the exact control key with owner set to the discovery thread and its
   returned evidence (including creation_actor). Use only claim.payload.native in
   the native create tool. Save its actual receipt with settle; confirm project
   placement from native list_threads. Project moves also require creation_actor.
5. Bind the verified owner using its native_binding and creation_action_key, then
   task start with creation_actor. Preserve native queue verification and all
   dependency, pause, approval and capacity guards. A create or queue receipt is
   insufficient: verify an actual original-owner runtime begin and its turn.

The fixed discovery batch cannot finish successfully while owner_creation still
needs setup or actual execution. If a real permission, native-tool, queue, project
or dependency blocker remains, finish with owner_creation_reason describing it;
the durable checkpoint keeps the same task/action and normal retry interval.
Never create another chat to bypass an uncertain receipt or a paused task.

The separately authorized Review Queue keeps its own selected read-only PR-owner
flow. It supplies creation_actor with its original service thread and fresh proof
of its current running native wake. Its durable admission and exact review-only
task/PR scope are checked; that exception cannot create implementation owners.
Main remains excluded from both creation routes. Existing project-assignment,
model, authorization, receipt and external-action guards all still apply.

This is an application guard over supported workflow operations and genuine
native tool evidence, not an OS security boundary against direct database edits
or callers fabricating tool exports. Do not bypass the workflow APIs.
