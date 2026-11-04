import { DatabaseSync } from 'node:sqlite';
import { existsSync,readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function mailTaskIds(payload) {
  return [...new Set([payload?.task_id,...(Array.isArray(payload?.task_ids)?payload.task_ids:[])].filter(id=>typeof id==='string'&&id))];
}

export function reactiveOwners(databasePath) {
  if(databasePath===':memory:')return new Set();
  const path=resolve(dirname(databasePath),'control.sqlite');if(!existsSync(path))return new Set();
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_tasks'").get())return new Set();
    return new Set(db.prepare("SELECT task_id FROM rt_tasks WHERE mode IN ('active','paused')").all().map(t=>t.task_id));
  }finally{db.close();}
}

export function nativeControlRuntime(databasePath) {
  if(databasePath===':memory:')return false;
  const root=dirname(databasePath),config=resolve(root,'runtime.json'),instance=resolve(root,'instance.json'),path=resolve(root,'control.sqlite');
  if(![config,instance,path].every(existsSync))return false;
  const settings=JSON.parse(readFileSync(config,'utf8')),binding=JSON.parse(readFileSync(instance,'utf8'));
  if(!settings.control_lanes||settings.control_lanes.coordinator?.thread_id!==binding.threads?.coordinator)return false;
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='rt_process'").get())return false;
    const row=db.prepare('SELECT * FROM rt_process WHERE id=1').get();
    if(row?.instance_id!==binding.instance_id)return false;
    try{process.kill(row.pid,0);return true;}catch{return false;}
  }finally{db.close();}
}
