# Owner waits

Report a wait when no useful authorized action remains. Runtime owns the waiting;
there is no coordinator reminder or periodic owner turn just to recheck evidence.
Read the current checkpoint and submit `runtime op decide` with the original task,
owner, acknowledged wake, and expected context/plan revisions. Finish that wake.

## Authentication is not an unexplored access wait

For AWS authentication failures, follow AUTH_RECOVERY.md before an access wait.
Save the current identity failure, recovery owner, supported attempts (including
explicit Bitwarden Fill where available), and the visible remaining factor.
An expired token or failed passive autofill alone does not establish a human
blocker. Reuse shared successful login and revalidate guest credentials; source
expiry must not keep a repaired session blocked. Never record credentials.

## Wait for a real source change

Use `disposition: "wait"` with a typed condition and exact checkpoint fact versions.
For a blocking PR, observe it first, then use this decision fragment:

```json
{
  "disposition": "wait",
  "reason": "Implementation requires the producer PR to merge",
  "evidence_refs": ["path/to/actual-pr-observation.json"],
  "wait": {
    "condition": {
      "kind": "pr_state",
      "pr_key": "example/service#123",
      "fields": ["state"]
    },
    "facts": [{"subject": "example/service#123", "version": "checkpoint-fact-version"}],
    "expires_at": 1794096000000,
    "resume_condition": "Producer PR merges or closes"
  }
}
```

Replace the example expiry with a future evidence recheck within one hour and
use current facts, not copied example data. Allowed PR fields are `state`,
`head_sha`, `merge_sha`, `draft`, `approval_state`, and `checks_state`. Default
fields are state/head/merge SHA. Select `state` when only merge/close matters.
Runtime registers a shared, read-only collector for this PR in the authorized
repository scope. Observing another task's PR never transfers its ownership.
Unrelated actionable inputs for the waiting task still take effect.

Dependency, access, job, PR approval/CI, and review-request waits default to
`wake_on: "change"`. Source observations refresh evidence without owner messages.
Repeated identical states, timestamps, and pending-to-running job progress are
quiet. Completion, failure, availability, and relevant PR changes become events.
Expired evidence produces a source-stale diagnostic; it does not establish a
change or a verified fresh wait. Generic event/job producers must publish actual
observations through `runtime op wait_observe`; runtime cannot infer unobserved
external results. Source writes retain a durable outbox until event publication.

A genuine review-window deadline retains its clock behavior. Use
`wake_on: "deadline"` only for a real timed recheck, not evidence expiry. Legacy
unchanged lifecycle reminders stay pending until facts or the plan change.

## Report the next useful action time

When you know or can reasonably estimate the next time useful work can proceed,
report `next_action_at` in the wait decision, with an explicit timezone:

```json
{
  "disposition": "wait",
  "reason": "The long test cannot yield a useful result before its checkpoint",
  "evidence_refs": ["path/to/job-status.json"],
  "next_action_at": "2026-11-09T16:00:00+08:00"
}
```

Supply a real future time within 365 days. A time-only wait needs no invented
external fact. You may also include a typed `wait` and its real facts. The action
time is separate from source freshness; it never extends source evidence or
changes task permissions. `checkpoint.owner_next_action` exposes the window.

Before that time, automatic events stay durable inside runtime. They do not send
native messages, load the conversation, or trigger queue recovery, even if the
computer is idle. This covers all existing tasks sharing the same owner. At the
deadline, runtime coalesces pending inputs into one owner wake. Paused tasks,
independent decisions, uncertain deliveries and running turns keep their existing
guards. Already accepted native queue messages cannot be retracted.

Revise an estimate with another acknowledged wait decision. A non-wait decision
by the originating owner replaces its window. Only an explicit actual human
instruction may clear it early through `runtime op clear_next_action`, with
`task_id`, `actual_human_verified: true`, `source_message_id`, and `evidence_ref`.
Clearing the time window preserves other holds and releases pending eligible
shared-owner inputs; ordinary source text cannot authorize an override.
