import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

export async function t3Main(args,{output=v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')}={}){
  const command=args[0],option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  if(command==='ledger'){
    const instance=option('instance'),file=option('file');
    if(!instance||!file)throw Error('Use t3 ledger --instance <T3-native root> --file <operation.json>');
    const {runT3Ledger}=await import('./ledger.mjs');
    output(runT3Ledger(resolve(instance),JSON.parse(readFileSync(resolve(file),'utf8'))));return;
  }
  if(command==='status'){
    const instance=option('instance');if(!instance)throw Error('Use t3 status --instance <T3-native root>');
    const c=JSON.parse(readFileSync(join(resolve(instance),'t3-workflow.json'),'utf8'));
    output({project_id:c.project_id,control_plane:c.control_plane??null,policy_store:c.policy_store??null,
      admission_paused:c.processing===false||c.task_admission?.paused===true,
      resumed_owner_ids:c.migration?.resumption?.target_thread_ids??[],
      execution_status_source:'t3_thread_read / t3_thread_list',attention_source:'native pending requests / native thread controls',
      note:'Local records preserve contracts, human authority and receipts; they do not schedule, wake, poll or set native execution/attention state.'});return;
  }
  if(command==='detach-runtime'){
    const instance=option('instance'),file=option('file');
    if(!instance||!file)throw Error('Use t3 detach-runtime --instance <T3-native root> --file <native-human-proof operation.json>');
    const {detachLegacyRuntime}=await import('./policy-store.mjs');
    output(detachLegacyRuntime(resolve(instance),JSON.parse(readFileSync(resolve(file),'utf8'))));return;
  }
  if(['prepare','probe'].includes(command))throw Error('Legacy preparation/transport probes are not part of the native execution profile; use T3 native tools');

  output({commands:['t3 ledger --instance <root> --file <operation.json>','t3 status --instance <root>','t3 detach-runtime --instance <root> --file <native-human-proof operation.json>'],execution:'T3 native tools',local_scheduler:false});
}
