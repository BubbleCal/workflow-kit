export const ENGINEERING_GUIDANCE = '[workflow-engineering-principles:v1]\nUse the actual authorized product workload for benchmarks, including S3 where required; microbenchmarks explain mechanisms, not product benefits. Establish product maturity and real consumers briefly within the work: unshipped iterations do not need hypothetical compatibility layers. Challenge existing design from goals and constraints; a breaking label alone is not an approval gate within authorized scope, while real stable contracts, user holds and production commitments remain binding. Use the smallest sufficient tests/checks/fallbacks for concrete risks, reuse valid same-state evidence and preserve required repository checks. Do not add preparation-only rounds or rerun completed benchmarks merely for process compliance. Continue substantive work allowed by actual native permissions; do not change those permissions or external communication boundaries.';

export function withEngineeringPrinciples(kind, payload) {
  if (!['dispatch','create_thread'].includes(kind)) return payload;
  const result = { ...payload, engineering_guidance_version: 1 };
  const resultRule = '[workflow-result-contract:v2]\nAt a meaningful stage end, report the original task/owner, exact result evidence and a concrete disposition: deliver, continue a specific authorized step, a verifiable wait, a scoped decision, or accepted completion/no-go. Test success alone does not finish the goal. If using the workflow mailbox, enqueue kind=worker_result with task_id, owner_thread_id and evidence_ref; for a deliverable PR also include its exact repository/number/head and validation/review references, distinguishing it from dependency PRs. Then end; never message control chats. Reuse existing evidence and do not run extra tests just for reporting.';
  const append = text => {
    let value = text.includes('[workflow-engineering-principles:v1]') ? text : `${text}\n\n${ENGINEERING_GUIDANCE}`;
    if (payload.result_contract_version === 2 && !value.includes('[workflow-result-contract:v2]')) value += `\n\n${resultRule}`;
    if (payload.dependency_guidance_version === 1 && !value.includes('[workflow-dependency-route:v1]'))
      value += '\n\n[workflow-dependency-route:v1] For governed dependency adoption, follow DEPENDENCY_PROVENANCE.md and the instance policy. Reuse a suitable published upstream release, observe the existing automatic mirror sync, then use the normal consumer dependency PR and required integrated acceptance. Do not substitute a manual mirror PR or an unpublished production pin. A closed-unmerged dependency is not delivered; persist the correct authorized successor. This guidance changes no live job or release authorization.';
    return value;
  };
  if (typeof payload.prompt === 'string') result.prompt = append(payload.prompt);
  if (typeof payload.native?.prompt === 'string') result.native = { ...payload.native, prompt: append(payload.native.prompt) };
  return result;
}
