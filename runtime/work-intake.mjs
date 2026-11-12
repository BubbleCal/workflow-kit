// Closing intake preserves accepted work and its original execution guards.
export function newTaskIntakeEnabled(db){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_rules'").get())return true;
  const row=db.prepare("SELECT data FROM work_rules WHERE key='new_task_intake'").get();
  return !row||JSON.parse(row.data).enabled!==false;
}
export function requireNewTaskIntake(db){
  if(!newTaskIntakeEnabled(db))throw new Error('New task intake is closed; continue accepted existing work or use the T3 workflow');
}
