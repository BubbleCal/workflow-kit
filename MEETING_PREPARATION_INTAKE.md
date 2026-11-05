# Authorized preparation intake belongs to discovery

The saved `accept_calendar_preparation` policy contains the actual human source,
calendar identity, enabled profiles, explicit exclusions, language/scope and the
45-minute preparation lead. It also authorizes creating one independent execution
owner for each accepted occurrence. This does not grant engineering, event edits,
RSVPs, external messages or preparation for excluded/unknown profiles.

For calendar observations, read the full event and pass it as `meeting` to
`discovery classify`. The program verifies the exact calendar/event, attendance,
profile and exclusions. Authorized occurrences become accepted ordinary tasks in
the same transaction, with no candidate notification to main. Unknown preparation
scope can remain a genuine user decision; missing event data is a source-read
problem, not a reason to ask for authorization again.

For accepted calendar tasks without an owner, discovery uses `task request_owner`
without inventing a new source message. The saved scoped policy supplies the real
creation authorization. Read the native project catalog, then call `task op` with
`op="prepare_owner"`, task_id, projects (the actual native catalog array),
project_catalog_ref and checked_at. This derives ownership/authorization facts
from the catalog and supplies the exact control evidence fields. Use its returned
key/evidence for control claim, invoke only claim.payload.native once, settle the
actual result and confirm native project placement, then `task bind_owner` and `task start`. Starting a
preparation task now installs its bound one-time runtime schedule automatically.
It does not prepare the brief early. Repeated start retains the same schedule.

Before every creation, inspect the task, owner request and creation receipt. Never
create twice after an ambiguous outcome. Reuse the original occurrence's owner
and results. One task has one owner; discovery never writes the meeting brief.
For moved events, `requires_reschedule` keeps the old contract unchanged: cancel
only its pending old timer, amend the original task under the saved meeting rule,
and install the new generation. Preserve in-flight preparation and recheck the
live event at execution. Cancellation/decline/exclusion means skip, not completion
of a brief or a new user question. Do not replace native timers already bound to
older occurrences with a second driver.

Finish a calendar scan only after these accepted follow-ups are bound and
scheduled, or checkpoint a concrete technical blocker. Do not send owner setup,
calendar intake, scheduling progress or routine blockers to the main conversation.
