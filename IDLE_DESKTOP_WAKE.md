# Idle-only desktop loading

An actual user may authorize the runtime to load already-queued Codex chats with
`/usr/bin/open -g -b <verified-bundle> codex://threads/<existing-uuid>` while this
Mac is idle. This can change the selected chat and foreground application. It is
allowed only under the explicit idle-only policy; ordinary agents do not gain
permission to navigate the UI themselves.

## Configuration

`runtime.json` contains the instance configuration. Example:

```json
{
  "desktop_loader": {
    "enabled": true,
    "mode": "idle_only",
    "bundle_id": "com.openai.codex",
    "authorization_ref": "/absolute/path/to/actual-user-authorization.json",
    "evidence_file": "/absolute/path/to/verified-desktop-loading-proof.json",
    "evidence_digest": "sha256-of-that-file",
    "min_idle_ms": 600000,
    "check_interval_ms": 15000,
    "open_interval_ms": 30000,
    "retry_interval_ms": 300000,
    "queue_grace_ms": 30000,
    "excluded_task_ids": []
  }
}
```

`min_idle_ms` is the configurable input inactivity threshold; 600000 means ten
minutes without keyboard or pointer input. The enabled runtime reloads this value
before each attempt, so changing the threshold needs no restart. Setting enabled
false stops future automatic opens. Changing the authorization, mode or bundle
requires verified startup again. Other interval changes take effect on restart.

The runtime reads macOS IOHIDSystem.HIDIdleTime and power assertions. Input activity,
a recent or unparseable UserIsActive assertion, or a display-sleep assertion held by a media/other application prevents
navigation. Universal Control's long-lived display assertion alone does not prove
user presence; it is ignored while real input idle and UserIsActive still apply.
Boot-time/old UserIsActive assertions can also persist on a mini: only assertions newer than one minute (or with unreadable ages) add an activity hold; actual HID input still resets the configured idle threshold. These are operating-system signals, not certainty about whether someone is reading
without input. Unknown/malformed/stale readings fail closed and leave the queue.

## Execution and preservation

- Queue submission remains the same in both active and idle states. Loading never
  sends or duplicates a work message, resumes a CLI backend, or changes task scope.
- Only accepted native queued work and an actually sent, still-pending discovery
  batch qualify. Running, claimed or uncertain wakes, task pauses, execution holds,
  decisions, explicit exclusions and on-request main inboxes are protected.
- Read input activity once for selection and again immediately before open. Recheck
  the exact queue, ownership and live policy at the final boundary. Returning input,
  native consumption or disabling/changing the policy cancels the selected open.
- Open one target at a time with a global interval; use durable exact-wake retries
  with exponential backoff capped at 30 minutes. Legacy loader receipts remain
  untouched. `rt_idle_desktop_loads` records attempts and outcomes across restarts.
- Open success means only that macOS accepted navigation. Original native begin,
  turn identity and substantive progress prove execution. Preserve the original
  queue ID even when the chat starts through loading.
- Enabling this policy does not remove product/deployment holds, bypass native
  access controls or keep a sleeping/offline computer executing. Preserve normal
  event eligibility and business acceptance.

Disable with desktop_loader.enabled=false to roll back behavior immediately.
Restore only the task-specific code/configuration diff if reverting the feature;
keep all real queued messages, execution receipts and new audit rows.
