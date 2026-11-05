> In native owner-delivery mode, main owns the shared decision list and decision-page projection. Each task owner owns only its task outcome rows. The native catalog is authoritative; legacy registry is historical. The old coordinator-only writer rule below is superseded.

# One task sequence for user-facing work

Use the existing canonical T task number for work, answers and pending decisions.
Display a choice as `T-010 · 待你决定：Java build approach`. Multiple questions
under a task use descriptive subjects, not another visible numbered sequence.
Never create another T task merely to number a question.

The coordinator remains the sole writer of decisions.json, registry.json and
bound Notion pages. Keep all existing D IDs, aliases, next_id history, question
text, statuses, source answers, mailbox keys and receipts. Stop allocating new
visible D IDs. New question records use a private deterministic identity derived
from the parent task and stable dedup_key. Changing a label does not create a
material notification or authorize a resend, resolve a question, complete a
task, or reopen an already resolved question.

## Supported read-only preparation and routing

Pass JSON stdin to `node runtime/task-decisions.mjs`. The CLI reads this instance's
decisions.json; it does not write it or enqueue a side effect.

- `{"op":"view"}` returns current pending questions using T IDs and subjects.
- `{"op":"prepare_question","question":{"task_id":"T-010","dedup_key":"java-build-approach","subject":"Java build approach","question":"Which approach?","evidence_ref":"actual-source"}}`
  returns an existing record or a new private record for the coordinator to save.
  The same task/dedup key keeps its original identity, including legacy D aliases.
- `{"op":"resolve_reply","reply":{"reference":"T010","subject":"Java"}}`
  selects a pending question if unambiguous. Legacy references such as D011 work.
  Use question_key or context_message_id from actual source context when present.
  Exact option IDs/labels can narrow multiple candidates only if unique; A shared
  by two questions remains ambiguous. No-match/conflicting context is not consent.
- `{"op":"render_text","text":"D-011 needs your answer"}` returns a display view.
  Known aliases become their parent T label; URLs and durable machine keys remain.

resolve_reply selects a question, not the meaning or authorization of an answer.
The inbox/coordinator must read the actual human message, retain it verbatim,
interpret free-form intent within the original scope and clarify only genuinely
ambiguous answers. Do not use substring matching as proof of approval. Normal
human-source, side-effect, permission and task-acceptance guards still apply.

## Actual queue integration

New control notify preparations render known aliases as T labels; a decision
notice requires its canonical parent task and rejects an unknown new D label.
The original control payload and action key remain unchanged. Re-preparing an
already queued key reuses its existing immutable mail instead of rewriting it
when labels/status change. Sent/claimed/uncertain deliveries are never replayed.

For control human_input to the coordinator, pass decision_reply with the above
routing context, or preserve legacy_decision_alias/decision_id. The queue carries
private decision_route metadata alongside the exact original human text and
source message ID. matched grants no authority; ambiguous/no_pending_match stays
for actual coordinator interpretation or one precise clarification. It does not
resolve records or send a worker message.

New inbox prompts also render old pending payloads as T-only display views.
Existing stored prompts, fixed snapshots and delivered messages stay immutable.
For an already in-flight legacy prompt, the inbox may use render_text for its
presentation; it must not rewrite the historical payload or resend the notice.

## Managed page cutover

The coordinator rereads the bound decision page and updates current headers,
reply examples and pending-question labels to T plus subject. Preserve historical
aliases/links, decisions and user notes. Keep unresolved questions unresolved;
apply any newer actual human answer through the ordinary separate resolution
path, never as an effect of this display migration. Record projection receipts
without notifying the user again solely because a number changed.
