import { mkdtempSync, cpSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync(join(tmpdir(),'workflow-kit-tests-'));
try {
  cpSync(join(source,'runtime'),join(dir,'runtime'),{recursive:true});
  const fixture={instance_id:'fixture',threads:{coordinator:'fixture-coordinator',inbox:'fixture-inbox',maintenance:'fixture-maintenance',dispatcher:'fixture-dispatcher'},
    scope:{project_id:null,repositories:['example/service','example/client','example/format']},identity:{github_login:'test-author'},
    delivery:{slack_enabled:true,slack_channel_id:'fixture-pr-channel',ready_enabled:true,merge_enabled:true,approver_login:'test-reviewer',notion_enabled:true,notion_page_id:'fixture-notion-page'}};
  writeFileSync(join(dir,'instance.json'),JSON.stringify(fixture));
  writeFileSync(join(dir,'pr-review-window.json'),JSON.stringify({timezone:'Asia/Shanghai',blocked_start_inclusive:'03:00:00',blocked_end_exclusive:'10:00:00'}));
  const tests=readdirSync(join(dir,'runtime')).filter(p=>p.endsWith('.test.mjs')).map(p=>join(dir,'runtime',p));
  const core=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});
  if(core.status!==0)process.exitCode=core.status??1;
  else {
    const integration=spawnSync(process.execPath,['--test',join(source,'tests/portable.test.mjs')],{stdio:'inherit'});
    if(integration.status!==0)process.exitCode=integration.status??1;
  }
} finally {rmSync(dir,{recursive:true,force:true});}
