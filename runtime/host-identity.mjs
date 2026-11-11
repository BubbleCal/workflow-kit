import {hostname,homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const hash=value=>createHash('sha256').update(value).digest('hex');
export const legacyHostFingerprint=()=>hash(JSON.stringify([hostname(),homedir()]));
export function macHostFingerprint(machineId,home){
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(machineId??'')||/^(0|-)+$|^(f|-)+$/i.test(machineId)||typeof home!=='string'||!home.startsWith('/'))throw Error('Actual macOS hardware identity and user home required');
 return hash(JSON.stringify(['workflow-native-host-v2','darwin',machineId.toLowerCase(),home]));
}
let machineId;
export function queueHostFingerprint(){
 if(process.platform!=='darwin')return legacyHostFingerprint();
 if(!machineId){const output=execFileSync('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8',timeout:5000,maxBuffer:65536});machineId=output.match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i)?.[1];}
 // Host names can change with networking. Hardware and home keep the two Macs
 // distinct without exporting their raw hardware identifier.
 return macHostFingerprint(machineId,homedir());
}

export function verifyMigratedHostBinding(proof){
 const binding=proof?.host_binding;if(!binding)return;
 if(binding.schema_version!==2||binding.scheme!=='macos-platform-uuid-and-user-home-v2'||!binding.source_message_id||!binding.authorization_ref||!Number.isFinite(Date.parse(binding.verified_at))||Date.parse(binding.verified_at)>Date.now()+5000)
  throw Error('Invalid verified host-binding migration');
 const bytes=readFileSync(binding.original_evidence_ref);
 if(hash(bytes)!==binding.original_evidence_digest)throw Error('Original native evidence changed after host migration');
 const original=JSON.parse(bytes),restored={...proof,host_fingerprint:binding.original_host_fingerprint};delete restored.host_binding;
 if(original.host_binding||original.host_fingerprint!==binding.original_host_fingerprint||!isDeepStrictEqual(restored,original))throw Error('Host migration must preserve all original native evidence and timestamps');
}
