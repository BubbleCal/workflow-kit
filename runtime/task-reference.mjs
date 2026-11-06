import {ControlStore} from './control.mjs';
import {INSTANCE_ROOT} from './instance.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// Human-facing references never rewrite active wake IDs, receipts or history.
const input=JSON.parse(readFileSync(0,'utf8'));
const control=new ControlStore(join(INSTANCE_ROOT,'control.sqlite'));
try {
  let result;
  if(input.op==='assign')result=control.work.assignReference(input);
  else if(input.op==='resolve')result=control.work.resolveReference(input.reference);
  else throw new Error('Use assign or resolve');
  process.stdout.write(JSON.stringify(result)+'\n');
} finally {control.close();}
