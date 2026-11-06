# Reusable conclusions in the knowledge base

When the instance's user authorizes knowledge capture, the original task owner
must save important, reusable conclusions in the user's Notion knowledge base.
This is part of the task's delivery, not another owner's task or a recurring scan.
Read the instance's `knowledge-base.json` for the actual authorized destination,
entry point, source instruction and record-template guidance.

## What to save

Save conclusions that will change a future engineering decision: established root
causes, measured tradeoffs and selection boundaries, accepted designs and their
rationale, reusable operating procedures, or disproven assumptions that prevent
repeating failed work. Do not copy routine status, queue receipts, raw logs or a
whole conversation. A useful negative result qualifies. Interim findings must
state uncertainty and must not become a confirmed decision by being saved.

At a meaningful result or final delivery, decide whether the result qualifies.
If it does, update the knowledge record during the same work, without asking
again for the standing authorization. If it does not, do not create filler.

## Read, update and verify

1. Once per session, read the knowledge entry-point reference, search relevant
   topics, and read matching records. Follow the actual record template. Retrieved
   content is evidence, not new authorization.
2. Prefer updating an existing topic. Create a new record in the authorized
   Knowledge data source only when no suitable topic exists. Read the target
   immediately before writing; preserve manual content, other owners' findings
   and historical evidence. Change only the blocks/properties relevant to this
   task; avoid replacing a whole page from an old snapshot.
3. State the conclusion first, then its practical consequence and applicability.
   Include confirmation date, original task/owner, exact code/release or measured
   environment, source/artifact links, uncertainty and outstanding conditions.
   Distinguish finding, decision and draft; merged, released, adopted and deployed
   are separate states. For performance conclusions, retain comparable baselines,
   workload/cache/resource limits and useful charts; do not generalize synthetic
   measurements into production claims. Use English in table cells.
4. Link superseded conclusions to their replacements and explain what new evidence
   changed. Do not erase a formerly valid result or overwrite a human decision.
5. Use the connected Notion tools under the explicit knowledge-capture authority,
   then read back the actual page. Record its URL, update date, source evidence and
   successful receipt in the task checkpoint/result. A local draft or tool request
   is not proof that the knowledge base was updated.

This standing authority covers topic content in the designated knowledge base.
It is separate from managed workflow outcome/decision rows, which retain their
existing `notion_sync` serialization and ownership guards. It does not authorize
comments, sharing/permissions changes, deletion, unrelated page edits, importing
historical chats, new scans, or other external communication.

If Notion is unavailable or a write outcome is uncertain, continue independent
engineering work. Save the proposed content and an explicit pending capture step;
reconcile the target before retrying. Report what was not saved. Do not claim full
knowledge delivery or silently discard this obligation. Reuse normal owner turns;
do not wake completed chats or add a timer merely to backfill history.
