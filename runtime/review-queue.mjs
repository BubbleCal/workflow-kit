import {ReviewClosure} from './review-closure.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ControlStore} from './control.mjs';
import {INSTANCE_ROOT} from './instance.mjs';
import {ReviewIntake,readReviewIntake} from './review-intake.mjs';
const input=JSON.parse(readFileSync(0,'utf8')),policy=readReviewIntake(INSTANCE_ROOT);
if(!policy?.enabled)throw new Error('Review Queue policy is not configured');
const c=new ControlStore(join(INSTANCE_ROOT,'control.sqlite'));
try{const intake=new ReviewIntake(c,policy);
 const result=input.op==='status'?intake.status():input.op==='admit'?intake.admit(input):input.op==='closure_targets'?new ReviewClosure(c,policy).targets():input.op==='complete_closed_review'?new ReviewClosure(c,policy).complete(input):input.op==='confirm_archive'?new ReviewClosure(c,policy).confirmArchive(input):(()=>{throw new Error('Use status, admit, closure_targets, complete_closed_review or confirm_archive');})();
 process.stdout.write(JSON.stringify(result)+'\n');
}finally{c.close();}
