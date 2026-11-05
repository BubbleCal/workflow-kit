# Upgrade an existing native instance to owner delivery

Copy-ready prompt for the maintenance agent on another Mac:

```text
Upgrade this workflow instance to workflow-kit 0.8.0 or newer and complete the
owner-delivery migration. This instruction authorizes a temporary scheduler/task
pause and retirement of the old central delivery service. Resume the originally
active authorized work afterward. Do not back up or run broad repeated audits.

Read OWNER_DELIVERY.md, the actual instance bindings and the old delivery task.
Keep every independent task and owner separate. Preserve original authorization,
models, permissions, holds, task IDs, native schedule times and the no-focus rule.
Do not turn candidates into implementation tasks or broaden external messaging.

Stop the workflow service and pause external action claims. Install the shared
runtime delta while preserving instance-specific modules. Set
instance.delivery.owner_managed=true and runtime.owner_delivery=true. Remove the
coordinator service mapping and legacy control_lanes. Retire/archive the old
delivery task; mark its wake obsolete without resetting accepted/uncertain sends.
Release its unprocessed mailbox inputs as pending and run routeOwnerInputs from
runtime/owner-delivery.mjs, transferring them to the original task owners. The
historical coordinator address is an input format only, never a destination chat.
Reconcile any existing claimed/uncertain external action before retrying it.

Transfer existing calendar preparation intake to the optional calendar discovery
source, with the same calendar, interval, lead time, exclusions and authorization.
Each task owner updates its own bound outcome rows. Main owns decisions and
completed-owner archival. Maintenance remains workflow-only at its configured
minimum interval. Do not replace the retired coordinator with a renamed service.

Publish one durable delivery_ownership_changed event to each unfinished original
owner, pointing to OWNER_DELIVERY.md and this actual user instruction. Update
current instance policy so older coordinator-only prompts no longer apply.
Restore the scheduler and original enabled scopes. Report the deployed commit,
retired service, transferred inputs and any actual remaining blocker. Do not claim
a queue receipt proves task execution, PR delivery or merge.
```
