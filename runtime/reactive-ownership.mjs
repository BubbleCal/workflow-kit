import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
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
