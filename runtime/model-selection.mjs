import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readModelSelection() {
  const path = fileURLToPath(new URL('../instance.json', import.meta.url));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).models?.roles?.execution ?? null : null;
}

// The creating agent judges the whole task, not its setup prompt or a keyword.
export function assessDifficulty(input) {
  if (input == null) return { level:'other', scope:'unknown', uncertainty:'unknown', validation:'unknown',
    reason:'No task difficulty assessment was supplied; use the conservative route.' };
  for (const [key, allowed] of Object.entries({ scope:['bounded','broad','unknown'], uncertainty:['low','material','unknown'], validation:['routine','specialist','unknown'] }))
    if (!allowed.includes(input[key])) throw new Error(`Invalid difficulty ${key}`);
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000)
    throw new Error('Task difficulty needs a concise reason grounded in its full scope');
  if (input.complexity!==undefined && !['difficult','extreme'].includes(input.complexity)) throw new Error('Invalid task complexity');
  if (input.target_repositories!==undefined && (!Array.isArray(input.target_repositories)||input.target_repositories.some(r=>typeof r!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(r))||!input.repository_evidence_ref?.trim()))
    throw new Error('Target repositories need exact owner/repo names and scope evidence');
  return { ...(input.complexity?{complexity:input.complexity}:{}),
    ...(input.target_repositories?{target_repositories:[...new Set(input.target_repositories)],repository_evidence_ref:input.repository_evidence_ref}:{}),
    level:!input.complexity&&input.scope==='bounded'&&input.uncertainty==='low'&&input.validation==='routine'?'simple':'other',
    scope:input.scope,uncertainty:input.uncertainty,validation:input.validation,reason:input.reason.trim() };
}

export const routineMeetingDifficulty = () => assessDifficulty({ scope:'bounded',uncertainty:'low',validation:'routine',
  reason:'One authorized meeting occurrence with a known preparation profile, bounded source synthesis and a fixed brief format; no implementation or experiments.' });

export function withCreationModel(kind, payload, selection) {
  if (kind !== 'create_thread' || !selection) return payload;
  const field = payload.native ? 'native' : payload.tool_args ? 'tool_args' : null;
  if (!field) throw new Error('Creation model preference requires supported native arguments');
  if (!selection.source_message_id) throw new Error('Creation model preference requires an actual source');
  if (selection.mode === 'task_difficulty') {
    for (const route of ['simple','other']) if (!selection.routes?.[route]?.model || !selection.routes[route].thinking)
      throw new Error('Difficulty routing needs both configured model and effort pairs');
    const assessment=assessDifficulty(payload.difficulty_assessment);
    let chosen=selection.routes[assessment.level];
    if (selection.repository_routes && assessment.target_repositories?.length) {
      const tier=assessment.level==='simple'?'simple':assessment.complexity??([assessment.scope,assessment.uncertainty,assessment.validation].includes('unknown')?'unknown':'difficult');
      const candidates=assessment.target_repositories.map(repo=>selection.repository_routes[repo]?.[tier]??chosen);
      for (const route of candidates) if (!route.model||!route.thinking||!Number.isFinite(route.priority))
        throw new Error('Repository routing needs model, effort and priority for every applicable route');
      chosen=candidates.reduce((a,b)=>b.priority>a.priority?b:a);
    }
    const override=payload.model_override;
    if (override) {
      if (override.actual_human_verified!==true || !override.source_message_id || !override.verbatim_text || !override.evidence_ref || !override.model || !override.thinking || !payload.canonical_task_key || override.canonical_task_key!==payload.canonical_task_key)
        throw new Error('A task-specific model override needs the actual user choice and evidence');
      chosen={model:override.model,thinking:override.thinking};
    }
    // Stale defaults supplied by an agent must not bypass the routing policy.
    // The action stores this assessment and policy so replays retain the choice.
    return {...payload,difficulty_assessment:assessment,model_selection:{...selection},
      [field]:{...payload[field],model:chosen.model,thinking:chosen.thinking}};
  }
  if (!selection.model || !selection.thinking) throw new Error('Creation model preference requires a model and effort');
  // Fast is a separate native tier; these arguments do not establish its state.
  return { ...payload, model_selection: { ...selection }, [field]: {
    ...payload[field], model: payload[field].model ?? selection.model,
    thinking: payload[field].thinking ?? selection.thinking,
  } };
}
