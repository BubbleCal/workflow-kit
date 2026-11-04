import { INSTANCE_ROOT } from './instance.mjs';
export function maintenanceSchedule(config) {
  if(config?.interval_minutes===undefined)return null;
  const interval=config.interval_minutes*60000,first=Date.parse(config.first_due_at);
  if(!Number.isSafeInteger(config.interval_minutes)||config.interval_minutes<=0||config.interval_minutes>10080||
    !Number.isFinite(first)||!/(?:Z|[+-]\d{2}:\d{2})$/.test(config.first_due_at??'')||config.timezone!=='Asia/Shanghai')throw new Error('A positive maintenance interval and explicit first due time are required');
  return {interval,first};
}
// The daily cutoff is Beijing time; delayed starts retain the original window.
export function dailyReviewEvent(now, config) {
  if (!config?.enabled) return null;
  const periodic=maintenanceSchedule(config);
  if(periodic){
    if(now<periodic.first)return null;
    const cutoff=periodic.first+Math.floor((now-periodic.first)/periodic.interval)*periodic.interval;
    const local=new Date(cutoff+8*3600000).toISOString(),date=local.slice(0,10),slot=local.slice(11,16).replace(':','');
    return {key:`workflow-maintenance-review:${new Date(cutoff).toISOString()}`,lane:'maintenance',kind:'daily_review',
      payload:{date,report_key:`${date}-maintenance-${slot}`,timezone:config.timezone,schedule_interval_minutes:config.interval_minutes,
        due_at:new Date(cutoff).toISOString(),window_start:new Date(cutoff-periodic.interval).toISOString(),window_end:new Date(cutoff).toISOString(),
        authorization_ref:config.authorization_ref,instructions:INSTANCE_ROOT+'/DAILY_REVIEW.md'}};
  }
  if (config.timezone !== 'Asia/Shanghai' || config.time !== '05:00') throw new Error('Expected the authorized 05:00 Asia/Shanghai schedule');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.first_date ?? '')) throw new Error('A first review date is required');
  const local = new Date(now + 8 * 3600000);
  if (local.getUTCHours() < 5) local.setUTCDate(local.getUTCDate() - 1);
  const date = local.toISOString().slice(0, 10);
  if (date < config.first_date) return null;
  const cutoff = Date.parse(`${date}T05:00:00+08:00`);
  return { key: `workflow-daily-review:${date}`, lane: 'maintenance', kind: 'daily_review',
    payload: { date, timezone: config.timezone, due_at: new Date(cutoff).toISOString(),
      window_start: new Date(cutoff - 24 * 3600000).toISOString(), window_end: new Date(cutoff).toISOString(),
      authorization_ref: config.authorization_ref,
      instructions: INSTANCE_ROOT + '/DAILY_REVIEW.md' } };
}
