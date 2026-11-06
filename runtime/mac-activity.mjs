import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);

export function parseMacActivity(hid,assertions,checked_at) {
  const values=[...hid.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)].map(m=>Number(BigInt(m[1])/1000000n));
  const active=assertions.match(/^\s*UserIsActive\s+([01])\s*$/m);
  const display=assertions.match(/^\s*PreventUserIdleDisplaySleep\s+([01])\s*$/m);
  if(!values.length||values.some(v=>!Number.isSafeInteger(v)||v<0)||!active||!display)
    throw new Error('macOS input idle and power assertion readings are incomplete');
  const holders=assertions.split('\n').filter(line=>/^\s*pid \d+\(/.test(line)&&/\bPreventUserIdleDisplaySleep\b/.test(line));
  const userHolders=assertions.split('\n').filter(line=>/^\s*pid \d+\(/.test(line)&&/\bUserIsActive\b/.test(line));
  // powerd may retain a boot-time UserIsActive assertion indefinitely. HID idle
  // remains authoritative; only recent or unparseable user assertions add a hold.
  const recentUserAssertion=userHolders.some(line=>{
    const age=line.match(/\]\s+(\d+):(\d{2}):(\d{2})\s+UserIsActive\b/);
    return !age||(Number(age[1])*3600+Number(age[2])*60+Number(age[3]))<60;
  });
  const user_active=active[1]==='1'&&(!userHolders.length||recentUserAssertion);
  // Universal Control can retain this assertion for hours after input stops;
  // it does not establish that somebody is watching or using this Mac.
  const display_busy=display[1]==='1'&&(!holders.length||holders.some(line=>!/^\s*pid \d+\(UniversalControl\):/.test(line)));
  return {source:'macos_hid_and_power_assertions',checked_at,idle_ms:Math.min(...values),
    user_active,display_busy,stale_user_assertions:active[1]==='1'&&!user_active,
    universal_control_only:display[1]==='1'&&!display_busy};
}

export async function readMacActivity({run=execute,now=()=>Date.now()}={}) {
  const options={timeout:2000,maxBuffer:1024*1024};
  const [hid,power]=await Promise.all([
    run('/usr/sbin/ioreg',['-c','IOHIDSystem','-d','4'],options),
    run('/usr/bin/pmset',['-g','assertions'],options),
  ]);
  return parseMacActivity(hid.stdout,power.stdout,now());
}

export function idleNavigationAllowed(activity,policy,now) {
  return policy?.mode==='idle_only'&&typeof policy.authorization_ref==='string'&&!!policy.authorization_ref.trim()&&
    Number.isSafeInteger(policy.min_idle_ms)&&policy.min_idle_ms>=60000&&
    activity?.source==='macos_hid_and_power_assertions'&&Number.isFinite(activity.checked_at)&&
    activity.checked_at<=now&&now-activity.checked_at<=3000&&
    Number.isSafeInteger(activity.idle_ms)&&activity.idle_ms>=policy.min_idle_ms&&
    activity.user_active===false&&activity.display_busy===false;
}

export function validateIdleNavigationPolicy(policy) {
  if(policy?.mode!=='idle_only'||!policy.authorization_ref||!Number.isSafeInteger(policy.min_idle_ms)||
    policy.min_idle_ms<60000||policy.min_idle_ms>86400000||
    !Number.isSafeInteger(policy.check_interval_ms)||policy.check_interval_ms<1000||policy.check_interval_ms>60000||
    !Number.isSafeInteger(policy.open_interval_ms)||policy.open_interval_ms<10000||policy.open_interval_ms>3600000||
    !Number.isSafeInteger(policy.queue_grace_ms)||policy.queue_grace_ms<0||policy.queue_grace_ms>300000||
    !Number.isSafeInteger(policy.retry_interval_ms)||policy.retry_interval_ms<60000||policy.retry_interval_ms>3600000||
    policy.excluded_task_ids!==undefined&&(!Array.isArray(policy.excluded_task_ids)||policy.excluded_task_ids.some(id=>typeof id!=='string'||!id)))
    throw new Error('Idle-only desktop loading requires actual authorization and bounded idle/check/open/retry intervals');
}
