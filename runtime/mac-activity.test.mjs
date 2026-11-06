import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMacActivity,readMacActivity,idleNavigationAllowed,validateIdleNavigationPolicy} from './mac-activity.mjs';

const power=(display=0,active=0,holder='')=>`Assertion status system-wide:\n UserIsActive ${active}\n PreventUserIdleDisplaySleep ${display}\nListed by owning process:\n${holder}`;
const hid='"HIDIdleTime" = 600000000000';
const policy={mode:'idle_only',authorization_ref:'actual-user',min_idle_ms:600000,check_interval_ms:15000,open_interval_ms:30000,retry_interval_ms:300000,queue_grace_ms:30000};

test('macOS nanoseconds become milliseconds with an inclusive configurable ten-minute boundary',()=>{
 const a=parseMacActivity(hid,power(),1000);assert.equal(a.idle_ms,600000);
 assert.equal(idleNavigationAllowed(a,policy,1000),true);
 assert.equal(idleNavigationAllowed({...a,idle_ms:599999},policy,1000),false);
 assert.equal(idleNavigationAllowed(a,{...policy,min_idle_ms:900000},1000),false);
 assert.equal(idleNavigationAllowed(a,policy,4001),false);
 assert.equal(idleNavigationAllowed({...a,checked_at:1001},policy,1000),false);
 validateIdleNavigationPolicy(policy);assert.throws(()=>validateIdleNavigationPolicy({...policy,min_idle_ms:0}),/bounded idle/);
});

test('media/display activity blocks navigation; stale Universal Control assertion alone does not prove presence',()=>{
 assert.equal(idleNavigationAllowed(parseMacActivity(hid,power(1,0,' pid 4(Google Chrome): [x] 00:20 PreventUserIdleDisplaySleep named: "video"'),1000),policy,1000),false);
 assert.equal(idleNavigationAllowed(parseMacActivity(hid,power(1,0,' pid 3670(UniversalControl): [x] 01:26 PreventUserIdleDisplaySleep named: "com.apple.universalcontrol.preventDisplaySleep"'),1000),policy,1000),true);
 assert.equal(idleNavigationAllowed(parseMacActivity(hid,power(1),1000),policy,1000),false);
 assert.equal(idleNavigationAllowed(parseMacActivity(hid,power(0,1),1000),policy,1000),false);
});

test('missing, failed or inconsistent activity readings never grant automatic navigation',async()=>{
 assert.throws(()=>parseMacActivity('missing',power(),1000),/incomplete/);
 assert.throws(()=>parseMacActivity(hid,'unavailable',1000),/incomplete/);
 assert.equal(parseMacActivity(hid+'\n"HIDIdleTime" = 1000000',power(),1000).idle_ms,1);
 await assert.rejects(readMacActivity({run:async()=>{throw new Error('ioreg timeout');}}),/timeout/);
 const calls=[];const a=await readMacActivity({run:async(bin,args)=>{calls.push({bin,args});return {stdout:bin.endsWith('ioreg')?hid:power()};},now:()=>1000});
 assert.equal(a.idle_ms,600000);assert.equal(calls.length,2);
});

test('mini boot-time and old UserIsActive assertions do not permanently block genuinely idle input',()=>{
 const old=' pid 553(powerd): [0x0001] 817:38:59 UserIsActive named: "com.apple.powerd.ws.initialize"\n pid 610(WindowServer): [0x0002] 01:40:46 UserIsActive named: "HID tickle"';
 const a=parseMacActivity(hid,power(0,1,old),1000);
 assert.equal(a.stale_user_assertions,true);assert.equal(idleNavigationAllowed(a,policy,1000),true);
 const recent=old+'\n pid 610(WindowServer): [0x0003] 00:00:05 UserIsActive named: "HID tickle"';
 assert.equal(idleNavigationAllowed(parseMacActivity(hid,power(0,1,recent),1000),policy,1000),false);
 assert.equal(idleNavigationAllowed(parseMacActivity('"HIDIdleTime" = 1000000',power(0,1,old),1000),policy,1000),false);
});
