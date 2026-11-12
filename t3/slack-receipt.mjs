import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const need=(v,m)=>{if(!v)throw Error(m);};
const unwrap=v=>v.structuredContent??(v.content?JSON.parse(v.content.find(c=>c.type==='text').text):v);

// The connector's send response proves location, not message content. Require
// a separate exact parent-message read; never manufacture Slack's raw ok/text.
export function verifyNormalizedSlackReceipt(receipt,payload,proof,expectedSender){
  const context=receipt.message_context,ts=context?.message_ts;
  need(context?.channel_id===payload.channel_id&&/^\d+\.\d{6}$/.test(ts??''),'Exact normalized Slack channel/timestamp required');
  const link=new URL(receipt.message_link);
  need(link.protocol==='https:'&&/^[\w-]+\.slack\.com$/.test(link.hostname)&&!link.username&&!link.password&&!link.search&&!link.hash&&
    link.pathname===`/archives/${payload.channel_id}/p${ts.replace('.','')}`,'Slack permalink must match exact channel/timestamp');
  need(proof?.source==='slack.read_thread'&&proof.channel_id===payload.channel_id&&proof.message_ts===ts&&proof.evidence_ref,
    'Independent exact Slack readback request required');
  const bytes=readFileSync(proof.evidence_ref),saved=JSON.parse(bytes),envelope=saved.response??saved;
  need(!envelope.isError,'Slack readback returned an error');const body=unwrap(envelope);
  need(typeof body.pagination_info==='string'&&body.pagination_info.trim()==='There are no more messages in this thread.','Complete Slack parent readback required');
  const parent=typeof body.messages==='string'&&body.messages.replaceAll('\r\n','\n').match(
    /^=== THREAD PARENT MESSAGE ===\nFrom: ([^\n]+)\nTime: [^\n]+\nMessage TS: (\d+\.\d{6})\n([\s\S]*?)\n\nNo thread messs?ages\n?$/);
  need(parent&&parent[2]===ts,'Exact complete Slack parent-message readback required');
  const identity=parent[1].match(/^(.+) \((U[A-Z0-9]+)\)$/),sender=identity?.[2];
  need(expectedSender&&sender===expectedSender,'Verified configured Slack sender required');
  const lines=parent[3].split('\n'),url=payload.message;
  const canonical=new Set([url,`<${url}>`,`<${url}|${url}>`,`<${url}|${url.replace(/^https:\/\//,'')}>`]);
  const authored=parts=>canonical.has(parts[0])&&(parts.length===1||parts.length===2&&/^\*Sent using\* <@U[A-Z0-9]+\|ChatGPT>$/.test(parts[1]));
  let contentLines=lines,authoredLines,generatedPreview,reactionMetadata;
  // This textual renderer does not delimit metadata structurally. A terminal
  // reaction line is only a candidate until a second rendering proves it was
  // absent from the authored body. Never discard arbitrary Reactions: text.
  if(lines.at(-1)?.startsWith('Reactions: ')){
    const rendered=lines.at(-1);
    need(/^Reactions: [a-zA-Z0-9_+-]+ \([1-9]\d*\)(?:, [a-zA-Z0-9_+-]+ \([1-9]\d*\))*$/.test(rendered),
      'Exact rendered reaction names and positive counts required');
    reactionMetadata={rendered};contentLines=lines.slice(0,-1);
  }
  authoredLines=contentLines;
  if(!authored(contentLines)){
    const start=contentLines.findIndex(line=>line.startsWith(`App notification from App (${url}): `));
    need((start===1||start===2)&&authored(contentLines.slice(0,start)),
      'Slack readback must contain only the canonical PR URL and optional standard connector attribution');
    authoredLines=contentLines.slice(0,start);generatedPreview={url};
  }
  if(generatedPreview||reactionMetadata){
    const concise=proof.concise_readback;
    need(concise?.source==='slack.read_thread'&&concise.response_format==='concise'&&concise.channel_id===payload.channel_id&&
      concise.message_ts===ts&&concise.evidence_ref&&concise.evidence_ref!==proof.evidence_ref,'Rendered metadata requires independent same-location concise readback');
    const raw=readFileSync(concise.evidence_ref),savedConcise=JSON.parse(raw),response=savedConcise.response??savedConcise;
    need(!response.isError,'Concise Slack readback returned an error');const view=unwrap(response);
    need(typeof view.pagination_info==='string'&&view.pagination_info.trim()==='There are no more messages in this thread.','Complete concise Slack readback required');
    const rendered=typeof view.messages==='string'&&view.messages.replaceAll('\r\n','\n').match(/^THREAD: ([\s\S]*?)\n\nNo thread messs?ages\n?$/);
    const authorSuffix=` [${identity[1]}]`;
    need(rendered&&rendered[1].endsWith(authorSuffix)&&rendered[1].slice(0,-authorSuffix.length)===authoredLines.join('\n'),
      'Concise readback must independently confirm the exact authored URL/attribution and matching sender label');
    const verifiedConcise={...concise,sha256:createHash('sha256').update(raw).digest('hex'),native_result:savedConcise};
    if(generatedPreview)generatedPreview.concise_readback=verifiedConcise;
    if(reactionMetadata)reactionMetadata.concise_readback=verifiedConcise;
  }
  return {protocol:'slack_normalized_exact_readback_v1',message_link:receipt.message_link,channel_id:context.channel_id,message_ts:ts,
    sender_id:sender,authored_message:url,connector_attribution:authoredLines.length===2,...(generatedPreview?{generated_preview:generatedPreview}:{}),
    ...(reactionMetadata?{reaction_metadata:reactionMetadata}:{}),
    readback:{...proof,sha256:createHash('sha256').update(bytes).digest('hex'),native_result:saved}};
}
