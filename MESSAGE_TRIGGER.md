# Runtime-authored message trigger

Yang authorized a dedicated trigger on 2026-11-11. The runtime alone registers
immutable owner IDs, prompts, task/source revisions and delivery identities in
`control.sqlite/rt_trigger_messages`. The trigger is a transmitter, not a
coordinator: it does not discover work, create owners, choose routes, rewrite
messages, change tasks, or perform product/external actions.

The existing automation `automation-3` is retargeted to the dedicated trigger.
Its configurable initial interval is one minute (`runtime.json/message_trigger`).
It does not change discovery's fifteen-minute gate, maintenance's eight-hour gate,
or any owner-reported next-action time. Processing off disables sending.

## Each scheduled invocation

Use supported native tools and the public command:

`node /Users/yang/.codex/workflow-system/workflow.mjs runtime trigger --file <JSON request>`

1. Read this trigger's actual latest native turn and persist the exact envelope.
   Wrap it with `source:"codex_app.read_thread"`, a real immediate `checked_at`,
   `evidence_ref`, and `readback`. Call `op:"run",native_proof:<wrapper>`.
   End immediately if `allowed:false`. Do not create another timer or loop until
   the next scheduled occurrence. Stop this invocation within fifty seconds.
2. Call `op:"pending",limit:4`. Empty results require no other work or notification.
   Read only the named target owners; never scan unrelated conversations.
3. For a pending message, read its `read_arguments`. Skip active, failed,
   interrupted, awaiting-user/approval, archived or unknown owners. A `notLoaded`
   owner additionally requires an actual `list_threads(mode:"history",
   archived:false)` page containing that exact local thread/cwd. Attach its exact
   wrapper as `active_listing` (source `codex_app.list_threads`, checked_at,
   request, readback). Page only as needed; if identity is unknown, skip it.
4. Call `op:"prepare",id,actor_proof:<self>,native_proof:<target>`.
   Save the returned digest and expected turn. No send is authorized yet.
5. Obtain a **second** fresh target readback, then call `op:"claim",id,digest,
   actor_proof:<fresh self>,native_proof:<second target>`. A proof must be at most
   fifteen seconds old; the second observation must be newer and show the same
   terminal turn. The runtime rechecks task/member revisions, holds, wait time,
   processing, ownership and competing effects. Only `send:true` grants one send.
6. Call `codex_app.send_message_to_thread` with the returned `arguments` exactly.
   Do not add model/thinking overrides, edit prompt text, append instructions,
   use a shell substitute, open any UI, or send a second copy. Save the entire
   native return **before** another action, then call `op:"settle",id,attempt_id,
   actor_proof:<fresh self>,native_result:<exact return>,evidence_ref:<saved file>`.
   Errors/timeouts remain uncertain. Never assume an error proves no delivery.
7. Read the target with `includeOutputs:true,maxOutputCharsPerItem:16000`, retain
   its complete incoming delegation, then call `op:"observe",id,actor_proof,
   native_proof`. Only a distinct actual turn containing the exact registered
   sender/input proves execution. An ACK alone is not execution; same-turn
   steering is not a successful idle dispatch. If observation is not yet possible,
   retain the send receipt and continue only independent candidates.
8. In later runs, inspect at most two `unresolved` entries using the same bounded
   native readback/observe path. Never resend a claimed, sent or uncertain entry,
   expire its claim, replace its message, or reconstruct missing evidence.
   Preserve unresolved conditions for existing maintenance. End quietly after
   the bounded batch; do not message main with routine transport updates.

Use real wall-clock checked_at values immediately after each native tool returns;
never refresh an old proof's timestamp. Persist proofs/requests/results under
`observations/message-trigger/<native-trigger-turn>/`, using distinct immutable
files per attempt. A self proof expires after sixty seconds; refresh it as needed.

## Receiver and transport rules

Receivers keep normal `begin → checkpoint → decide → finish`. For trigger-delivered
input, the initial self `read_thread` proof must use `includeOutputs:true` and
preserve the complete incoming `send_message_to_thread` functionCallOutput.
The runtime verifies the original trigger sender and exact immutable prompt;
it never invents a userMessage. Discovery retains its exact source batch,
generation, source coverage, native creation actor and guarded owner setup.

Pending events coalesce before registration. A changed context can supersede only
an unsent registration, preserving unhandled events for the next message. Once a
claim exists, it is not replayed automatically. A fresh successor cycle gets a
new identity. Explicit pauses, decisions, source scope, external-action gates,
expected heads and native model/permission settings remain unchanged.

Already accepted or uncertain native queues retain their original receipts and
are not converted to direct messages. Their old idle-only loader remains subject
to the existing configurable ten-minute input-idle gate; the trigger never opens
or selects chats. On-request main delivery remains on request. Original owners
still own all review/merge/completion delivery.

The native send tool has no atomic idle-only predicate. Two observations reduce
the status-check/send race, but cannot eliminate a simultaneous human start.
Actual turn readback detects same-turn steering or a missing start; preserve it
as unresolved rather than claiming reliable execution or blindly retrying.
