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
  const authorizations=policy?.pr_authorizations??[];
  if(policy?.schema_version!==1||!policy.source_message_id||policy.default_channel_id!==defaultChannel||
    typeof policy.default_channel_id!=='string'||!policy.default_channel_id||!Array.isArray(policy.routes)||policy.routes.some(r=>
      !r||typeof r.scope!=='string'||!r.scope||r.scope==='default'||!channel(r.channel_id)||
      r.delivery_hold!==undefined&&(typeof r.delivery_hold?.active!=='boolean'||
        !r.delivery_hold.source_message_id||!r.delivery_hold.evidence_ref))||
    new Set(policy.routes.map(r=>r.scope)).size!==policy.routes.length||
    !Array.isArray(authorizations)||authorizations.some(a=>!a||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(a.pr_url??'')||
      !channel(a.channel_id)||a.actual_human_verified!==true||!a.source_message_id||!a.evidence_ref||
      !policy.routes.some(r=>r.scope===a.scope))||
    new Set(authorizations.map(a=>a.pr_url)).size!==authorizations.length)
    return ['invalid_slack_routing_policy'];
  const route=evidence?.review_routing;
  if(route?.verified!==true||typeof route.evidence_ref!=='string'||!route.evidence_ref.trim()||
    route.pr_url!==payload?.message||route.pr_url!==evidence.pr_url||
    route.head_sha!==payload?.expected_head_sha||route.head_sha!==evidence.current_head_sha)
    return ['current_pr_review_scope_required'];
  const destination=route.scope==='default'?policy.default_channel_id:policy.routes.find(r=>r.scope===route.scope)?.channel_id;
  if(!destination)return ['unknown_pr_review_scope'];
  // A saved human decision overrides only this PR's scope hold and destination.
  // Current-head proof, readiness, feedback, deduplication and owner gates still apply.
  const authorized=authorizations.find(a=>a.pr_url===route.pr_url&&a.scope===route.scope);
  if(authorized)return payload.channel_id===authorized.channel_id?[]:['slack_destination_forbidden'];
  if(policy.routes.find(r=>r.scope===route.scope)?.delivery_hold?.active===true)
    return ['review_delivery_paused_by_user'];
  return payload.channel_id===destination?[]:['slack_destination_forbidden'];
}
