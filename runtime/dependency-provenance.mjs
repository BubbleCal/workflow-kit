import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sha = s => typeof s === 'string' && /^[a-f0-9]{40,64}$/.test(s);
const ref = s => typeof s === 'string' && !!s.trim();
export function readDependencyPolicy() {
  const path=fileURLToPath(new URL('../dependency-policy.json',import.meta.url));
  return existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
}
export function forkRoute(policy,repository) {
  return policy?.enabled===true && policy.source_message_id ? policy.routes?.find(r=>r.fork_repository?.toLowerCase()===repository?.toLowerCase()):null;
}
export function dependencyReasons(kind,payload,evidence,policy,now) {
  if (!['pr_ready','slack_pr','merge'].includes(kind) || policy?.enabled!==true || !policy.source_message_id) return [];
  const repo=(payload?.pr_url??payload?.message)?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/i)?.[1]?.toLowerCase();
  if (forkRoute(policy,repo)) return ['manual_internal_fork_delivery_forbidden'];
  const changes=evidence.dependency_adoption;
  if (!changes || !policy.routes?.some(r=>r.consumer_repository===repo)) return [];
  const reasons=[];
  if (!Array.isArray(changes.dependencies) || !changes.dependencies.length || changes.consumer_repository!==repo ||
      changes.consumer_head!==payload.expected_head_sha) return ['dependency_adoption_identity_required'];
  for (const d of changes.dependencies) {
    const route=policy.routes.find(r=>r.consumer_repository===repo && r.upstream_repository===d.upstream_repository && r.fork_repository===d.fork_repository);
    if (!route) { reasons.push('dependency_route_not_configured'); continue; }
    const release=d.release, sync=d.sync;
    if (!sha(d.required_commit) || release?.published!==true || release.draft!==false || !ref(release.tag) ||
        !sha(release.commit) || release.contains_required_commit!==true || !ref(release.evidence_ref) ||
        !Number.isFinite(Date.parse(release.published_at)) || Date.parse(release.published_at)>now+5000)
      reasons.push('published_upstream_containing_fix_required');
    if (sync?.method!=='existing_automation' || sync.result!=='success' || !ref(String(sync.run_id??'')) ||
        sync.upstream_tag!==release?.tag || sync.upstream_commit!==release?.commit || !sha(sync.commit) || !ref(sync.evidence_ref))
      reasons.push('verified_automatic_fork_sync_required');
    if (!sha(d.pin_commit) || d.pin_commit!==sync?.commit) reasons.push('consumer_pin_not_synced_release');
  }
  return [...new Set(reasons)];
}
export function releaseSuccessorVerified(goals,taskId,route) {
  for (const goal of goals??[]) {
    if (!goal.stages?.some(s=>s.task_id===taskId)) continue;
    const path=goal.dependency_delivery;
    if (!path || path.upstream_repository!==route.upstream_repository || path.fork_repository!==route.fork_repository ||
        path.consumer_repository!==route.consumer_repository || !sha(path.required_commit)) continue;
    const kinds=['upstream_release','automatic_fork_sync','consumer_adoption','integrated_acceptance'];
    const stages=kinds.map(kind=>goal.stages.find(s=>s.release_step===kind));
    if (stages.some(s=>!s)) continue;
    const reaches=(stage,id,seen=new Set())=>{
      if (seen.has(stage.id)) return false; seen.add(stage.id);
      return stage.depends_on?.includes(id) || stage.depends_on?.some(d=>{
        const parent=goal.stages.find(s=>s.id===d);return parent && reaches(parent,id,seen);
      });
    };
    if (stages.slice(1).every((s,i)=>reaches(s,stages[i].id)) &&
        !stages.some(s=>s.blocker?.condition?.kind==='pr' && s.blocker.condition.pr_key?.startsWith(route.fork_repository+'#')))
      return true;
  }
  return false;
}
