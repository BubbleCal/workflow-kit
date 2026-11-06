import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {bindings,INSTANCE_ROOT} from './instance.mjs';

// Read at each gate; a configured missing/broken file must not fall back.
export function readReviewChannels() {
  const file=bindings.delivery.slack_routing_file;
  return file ? JSON.parse(readFileSync(resolve(INSTANCE_ROOT,file),'utf8')) : null;
}

export function reviewDestinationReasons(payload,evidence,policy,defaultChannel=bindings.delivery.slack_channel_id) {
  if(policy===null)return payload?.channel_id===defaultChannel?[]:['slack_destination_forbidden'];
  const channel=value=>typeof value==='string'&&/^[CG][A-Z0-9]+$/.test(value);
  if(policy?.schema_version!==1||!policy.source_message_id||policy.default_channel_id!==defaultChannel||
    typeof policy.default_channel_id!=='string'||!policy.default_channel_id||!Array.isArray(policy.routes)||policy.routes.some(r=>
      !r||typeof r.scope!=='string'||!r.scope||r.scope==='default'||!channel(r.channel_id)||
      r.delivery_hold!==undefined&&(typeof r.delivery_hold?.active!=='boolean'||
        !r.delivery_hold.source_message_id||!r.delivery_hold.evidence_ref))||
    new Set(policy.routes.map(r=>r.scope)).size!==policy.routes.length)
    return ['invalid_slack_routing_policy'];
  const route=evidence?.review_routing;
  if(route?.verified!==true||typeof route.evidence_ref!=='string'||!route.evidence_ref.trim()||
    route.pr_url!==payload?.message||route.pr_url!==evidence.pr_url||
    route.head_sha!==payload?.expected_head_sha||route.head_sha!==evidence.current_head_sha)
    return ['current_pr_review_scope_required'];
  const destination=route.scope==='default'?policy.default_channel_id:policy.routes.find(r=>r.scope===route.scope)?.channel_id;
  if(!destination)return ['unknown_pr_review_scope'];
  if(policy.routes.find(r=>r.scope===route.scope)?.delivery_hold?.active===true)
    return ['review_delivery_paused_by_user'];
  return payload.channel_id===destination?[]:['slack_destination_forbidden'];
}
