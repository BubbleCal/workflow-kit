# One owner for meeting preparation

When accept_calendar_preparation names service_task_id, every authorized meeting
occurrence belongs to that single recurring task and its dedicated conversation.
The configured lead_minutes is the start lead, not a completion deadline. Use the
actual user rule; Yang selected 90 minutes on 2026-11-05. Keep existing exclusions,
Chinese briefs and English speaking points. Recording summaries remain separate.

Discovery reads the calendar and reconciles occurrence timers; it does not create
another task or owner per meeting. The service owns the actual preparation and
delivery. Main manages genuine decisions and the one-time consolidation.

At each actual due event, use normal native begin/checkpoint and inspect
schedule_runs. Read task op=meeting_occurrences for this task to map schedule_id
to the full event, preparation profile, generation and prior runs. Read the live
calendar event before starting and again before delivery. Skip cancelled,
declined, expired or excluded occurrences. Do not change Calendar or RSVP.

If time or attendance changed, task op=reconcile_meeting takes task_id,
calendar_id, full meeting, identity_verified=true and actual evidence_ref. It uses
the saved policy, preserves previous generations and cancels obsolete pending
timers. It does not replace accepted running work. If the new preparation time is
still future, save the supported skip/reschedule result and wait. Unknown profile
or inaccessible sources remain explicit; do not silently invent evidence.

Prepare only the actual due occurrence, or work the user explicitly asked to start.
Use the relevant profile in the instance's meeting-prep/config.json and preserved
MEETING_PREP.md scope. Prioritize Yang's results, impact, blockers, decisions and
useful speaking points; avoid reproducing raw PR/check logs. Community-facing
briefs exclude confidential customer and nonpublic company details unless the user
has authorized their use. Do not edit shared agendas or send messages to others.

Save each brief and its source/limitation/result record separately by calendar,
event and generation under meeting-prep/briefs and meeting-prep/results. Reuse a
completed generation. Deliver once under the existing owner notification policy.
Finish each occurrence with cycle_complete and finish, never complete the whole
recurring service after one meeting. Simultaneous occurrences retain separate
pending runs and are handled in due-time order by the same conversation.

Main may consolidate old occurrence tasks only after their original owners are
quiescent, old native automations are verified paused, old pending timers are
cancelled, and their scope/evidence is preserved with the new active service.
Use task op=consolidate_meetings with actual user authority and fresh native
bindings. Superseded means scope transferred, not a meeting brief completed.
Archive old owners through purpose=task_consolidation and the ordinary guards;
do not archive the recurring service or recording-summary owner.
