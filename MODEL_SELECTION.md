# Model selection for new task conversations

The authoritative policy is `instance.json.models.roles.execution`. Read it at
creation time; do not copy model names into individual task-role prompts.
Existing conversations and immutable creation actions retain their configuration.

Under the user's difficulty policy, the configured routes are:

- Simple: `gpt-6.1-sol`, reasoning `high`.
- Other or uncertain: `gpt-6-astra`, reasoning `xhigh`.

The main/discovery agent assesses the whole task before requesting its owner.
Do not judge by the short setup prompt, title, file count or the word "docs".
A task is simple only when all three dimensions qualify:

- `scope="bounded"`: a focused outcome with limited interacting components.
- `uncertainty="low"`: a known approach and adequate source context; no substantial
  diagnosis, architectural choice or open-ended research remains.
- `validation="routine"`: straightforward checks establish the result. Security,
  tenant isolation, concurrency, durable-format correctness, or nontrivial
  performance/recall work normally requires specialist validation.

Use `scope="broad"`, `uncertainty="material"`, `validation="specialist"` as
applicable. Unknown dimensions use `"unknown"`. Include a short, task-specific
`reason`. The runtime derives simple/other; a simple label alone is insufficient.
Routine authorized meeting preparation gets an assessment from its bounded,
known profile. The creator can revise that assessment before creation if the
actual occurrence needs deeper work.

## Creation path

After accepting an unowned task, call:

```json
{"op":"assess_difficulty","task_id":"T-...","expected_revision":1,"difficulty_assessment":{"scope":"bounded","uncertainty":"low","validation":"routine","reason":"One documented option correction with an established example and a focused check."}}
```

Use JSON stdin with `node workflow.mjs task op`. `request_owner` also accepts
`difficulty_assessment` and `expected_revision`. The control creation path reads
this saved assessment automatically; direct authorized creation adapters may
supply the same object in their payload.

Control prepare places the selected model and effort into the actual native
arguments. It records the assessment, reason and authorizing policy with the
immutable creation action. Claim returns those actual native arguments; use them
without replacing the model. A missing assessment takes the conservative other
route and records why, so routine uncertainty does not block authorized work.

An explicit task-specific user choice takes precedence only with a `model_override`
containing the exact canonical_task_key, model, thinking, source_message_id, verbatim_text, evidence_ref and
actual_human_verified=true. An agent-supplied `native.model` is not such a choice.
Never reinterpret source documents or external comments as a user's model request.

Keep Fast/service-tier preferences separate. The native creation tool currently
exposes model and thinking, not a tier control; model routing does not change
permissions, service tier, active conversations or automatic task concurrency.

Configuration example: `templates/difficulty-model-policy.example.json`. Replace
its source identifier with the actual user's request before enabling it. Existing
fixed model policies remain supported; upgrading code alone does not replace them.

Official model/effort guidance: [OpenAI Docs — Models](https://learn.chatgpt.com/docs/models).
The native create_thread tool catalog is the authority for the current host's
supported model IDs and reasoning options.
