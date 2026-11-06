# Reusable conclusions in the knowledge base

When the instance's user authorizes knowledge capture, the original task owner
saves only conclusions that pass the admission criteria below. Knowledge capture
is not a completion checklist for every task. Skipping a record is the default;
it does not leave the task incomplete or create a pending delivery obligation.
Read the instance's `knowledge-base.json` for the actual authorized destination,
entry point, source instruction and record-template guidance.

## What to save

Before writing, answer: outside this task, what concrete future question or
decision will this conclusion help? Save only when all three conditions hold:

- There is a specific future use, not merely a hypothetical general lesson.
- The insight is nontrivial and not already adequately captured in an existing
  topic, maintained product documentation or self-explanatory code.
- Evidence supports the conclusion and its applicability is clear.

Measured selection boundaries, lasting architectural or semantic contracts,
accepted design rationale, recurring non-obvious failures with useful mitigation,
and negative results that avoid expensive repeated work can qualify. A solved
problem can still qualify when it has such lasting value; being solved is neither
an admission requirement nor an automatic exclusion.

A fix, merge, successful test, finished review, known standard-library behavior,
release status or one-off root-cause report does not qualify by itself. Keep these
in the original task, PR or report. Do not invent a generic lesson to justify a
record. A Draft also needs concrete future value; unfinished work is not knowledge
merely because it is unfinished. An explicit user request to save an item overrides
default admission, but not evidence, brevity or scope requirements.

At a meaningful result or final delivery, decide whether the result qualifies.
If it does, update the knowledge record during the same work, without asking
again for the standing authorization. Otherwise do not write anything or wake a
completed owner for this purpose. No mandatory no-capture form is needed.

## Keep each conclusion short and native

Lead with one to three sentences, followed only by the necessary future use,
scope, source and confirmation date. A few bullets, a small comparison table or
one useful chart is usually enough. Avoid empty template sections, task progress,
CI inventories, exhaustive hashes, cloud resource IDs and cleanup receipts.

Do not embed a full HTML report, upload HTML as the page's explanation, or paste
its source markup. Extract the necessary text, measurements and figures into
native Notion paragraphs, lists, tables and image blocks. The page must answer
the question without opening a report. Keep exhaustive evidence in the original
artifact and link it for optional verification. Brevity must not hide a material
limitation or change what a measurement actually established.

Update a topic only when the conclusion, supporting evidence or applicability
materially changes, not on every CI result, PR delivery, merge or release event.
Do not reinsert task histories removed by user-authorized curation. Historical
task-reference pages outside Knowledge are not default authoritative findings.

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
   Include confirmation date and minimal source provenance. Keep detailed owner
   receipts, exact run inventories and exhaustive environment data in the linked
   original evidence, not in the short conclusion.
   Distinguish finding, decision and draft; merged, released, adopted and deployed
   are separate states. For performance conclusions, retain comparable baselines,
   workload/cache/resource limits and useful charts; do not generalize synthetic
   measurements into production claims. Use English in table cells.
4. Link superseded conclusions to their replacements and explain what new evidence
   changed. Do not erase a formerly valid result or overwrite a human decision.
5. Use the connected Notion tools under the explicit knowledge-capture authority.
   Inspect the successful response and any warnings; read back when needed to
   resolve uncertainty or verify material structure. Record the URL and actual
   receipt in the task checkpoint/result. A local draft or tool request alone is
   not proof that the knowledge base was updated.

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
