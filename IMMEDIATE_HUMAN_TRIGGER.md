# Immediate dispatcher opportunity for actionable human input

An enabled instance binds queue_transport.immediate_human_trigger to its actual
human authorization source and existing dispatcher_thread_id. Never copy another
instance's IDs or enable this from an automated result. Existing ten-minute
scheduling remains the fallback; no extra timer or new service chat is created.

The normal control prepare(kind=human_input,target=coordinator) producer validates
the original human source, durably admits the command, and records one immediate
intent keyed by source_message_id. Mail and new intent are committed together.
Retries reuse the same source and action key. Pure answers need no queued action;
an informational envelope may explicitly set action_required=false. Notifications,
worker results and periodic machine events do not create trigger intents.

After the producer returns immediate_trigger, follow its concrete tool protocol:

1. Get the registered dispatcher's native wait_threads snapshot with timeoutMs=0;
   annotate checked_at at retrieval, preserving its exact status/turn/flags.
2. Call control.mjs op=human_trigger_prepare with source_message_id and snapshot.
3. If prepared, read a second fresh native snapshot, then call
   op=human_trigger_claim. Only send=true authorizes the returned
   send_message_to_thread native_arguments. Omit model and thinking.
4. Immediately call existing control op=settle using the returned key/attempt_id,
   outcome and exact native receipt. Timeout/ambiguous send is uncertain. Inspect
   the same workflow-human-trigger marker before reconciliation; never blind retry.

The original producer's send_tool_forbidden still forbids directly messaging the
coordinator. The new separate guarded service claim is the narrow exception for
the exact dispatcher only. This does not authorize messaging an engineering owner.

An active/unknown dispatcher is never steered. The intent stays durable and the
producer may make the returned bounded fifteen-second native wait for the current
short turn. Once it finishes, query human_trigger_status: an uncovered request
can immediately prepare/claim at the idle boundary. If still busy/unavailable,
retain the coalesced intent and end; do not claim it was delivered or covered.

mailbox plan captures an input sequence watermark before it considers the lanes.
Only after an actual fresh coordinator snapshot/plan does it persist coverage for
eligible source intents. Coverage means a processing opportunity, not admission
to a busy coordinator or engineering start/completion. A busy coordinator remains
protected and its original queued item survives. Later arrivals are not falsely
covered by an earlier watermark or an older consumed envelope.

After lane delivery, the dispatcher reads human_trigger_status and performs at
most one fresh tail plan if uncovered intents arrived. Both scheduled and manual
rounds use this sequence. Requests arriving after that boundary remain durable;
the producer's bounded wait or the existing heartbeat handles them. Native tools
do not provide an atomic idle-only send or unlimited immediate liveness guarantee.

Coverage and transport are separate: a scheduled round may cover a request whose
manual send outcome is uncertain. Keep the uncertain receipt and reconcile it;
coverage never invents a successful send. Preserve existing manual-bootstrap
receipts and already-consumed sources without another invocation.

No direct control callbacks, models/permissions changes, native access bypass,
external messages or per-task timers are introduced. The coordinator alone mirrors
instance acceptance/configuration. New portable instances require their own actual
user source; upgrade does not import or manufacture that authorization.
