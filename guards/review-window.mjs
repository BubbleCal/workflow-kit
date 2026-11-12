import { readFileSync } from 'node:fs';

export const REVIEW_WINDOW = Object.freeze({ timezone: 'Asia/Shanghai', blocked_start_inclusive: '03:00:00', blocked_end_exclusive: '10:00:00', weekly_blackout: { start_day: 6, start_time: '00:00:00', end_day: 1, end_time: '11:00:00' } });
export const isReviewDelivery = kind => ['slack_pr', 'pr_ready', 'review_decision'].includes(kind);
export function withReviewWindowGuidance(kind, payload, prior) {
  if (!['dispatch','create_thread'].includes(kind)) return payload;
  const version = prior?.review_window_guidance_version ?? 2;
  const marker = `[workflow-pr-review-window:v${version}]`;
  const original = prior?.prompt ?? prior?.native?.prompt;
  const saved = typeof original === 'string' && original.includes(marker) ? original.slice(original.lastIndexOf(marker)) : null;
  const rule = readReviewWindow();
  reviewWindowAt(Date.now(),rule);
  const weekly = rule.weekly_blackout ? ' Also stop all review delivery every Saturday and Sunday, and on Monday before 11:00; resume Monday at 11:00 (Asia/Shanghai).' : '';
  const guidance = saved ?? marker + `\nEvery day in ${rule.timezone}, do not send PRs for review from ${rule.blocked_start_inclusive.slice(0,5)} inclusive to ${rule.blocked_end_exclusive.slice(0,5)} exclusive.${weekly} Continue implementation, tests, repairs and internal review. Create new PRs as drafts; the original task owner performs authorized review-intended draft-to-ready transitions and canonical Slack URL delivery using control kind=pr_ready/slack_pr and authorize_review_send immediately before the external operation. Preserve deferred work until the original owner rechecks the current head/readiness/CI/Gatekeeper/receipts after the saved window opens. Do not bypass via direct non-draft creation, other channels, comments or reviewer requests; do not create a timer or restart healthy work.`;
  const append = text => text.includes(marker) ? text : text + '\n\n' + guidance;
  return { ...payload, review_window_guidance_version: version,
    ...(typeof payload.prompt === 'string' ? { prompt: append(payload.prompt) } : {}),
    ...(typeof payload.native?.prompt === 'string' ? { native: { ...payload.native, prompt: append(payload.native.prompt) } } : {}) };
}
export function readReviewWindow() {
  return JSON.parse(readFileSync(new URL('../pr-review-window.json', import.meta.url), 'utf8'));
}
export function scopedReviewRule(rule,now,{task_id,pull_requests=[],payload={}}={}) {
  const url=payload.pr_url??payload.message,match=typeof url==='string'&&url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/);
  if(!match||!pull_requests.some(p=>p.repository?.toLowerCase()===match[1].toLowerCase()&&p.pr_number===Number(match[2])))return rule;
  const exception=rule.scoped_weekly_exceptions?.find(e=>e.actual_human_verified===true&&e.id&&e.source_message_id&&e.evidence_ref&&
    e.waive_weekly_blackout===true&&e.retain_daily_blackout===true&&e.task_ids?.includes(task_id)&&
    Number.isFinite(Date.parse(e.valid_from))&&Number.isFinite(Date.parse(e.valid_until))&&Date.parse(e.valid_from)<=now&&now<Date.parse(e.valid_until));
  return exception?{...rule,scoped_weekly_exemption:{id:exception.id,from:Date.parse(exception.valid_from),until:Date.parse(exception.valid_until),source_message_id:exception.source_message_id}}:rule;
}
export function reviewWindowAt(now, rule = REVIEW_WINDOW) {
  const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value) ?
    value.split(':').reduce((n,p) => n*60+Number(p),0) : NaN;
  const start=time(rule?.blocked_start_inclusive), end=time(rule?.blocked_end_exclusive);
  if (!Number.isFinite(now) || rule?.timezone !== 'Asia/Shanghai' || !Number.isFinite(start) || !Number.isFinite(end) || start>=end)
    throw new Error('Missing or unsupported persisted PR review window');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: rule.timezone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' })
    .formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type,Number(x.value)]));
  const {year,month,day,hour,minute,second} = parts;
  const offset = Date.UTC(year,month-1,day,hour,minute,second) - Math.floor(now / 1000) * 1000;
  const week = rule.weekly_blackout;
  if (week && (week.start_day !== 6 || week.end_day !== 1 || week.start_time !== '00:00:00' || !Number.isFinite(time(week.end_time))))
    throw new Error('Unsupported weekly PR review blackout');
  const midnight = Date.UTC(year,month-1,day)-offset;
  const intervals = [];
  for (let delta=-7; delta<=8; delta++) {
    const date = new Date(Date.UTC(year,month-1,day+delta));
    const base = midnight + delta*86400000;
    intervals.push([base+start*1000, base+end*1000]);
    if (week && date.getUTCDay()===week.start_day){
      const to=base+2*86400000+time(week.end_time)*1000,ex=rule.scoped_weekly_exemption;
      if(ex&&ex.from<=now&&now<ex.until){
        if(base<ex.from)intervals.push([base,Math.min(to,ex.from)]);
        if(to>ex.until)intervals.push([Math.max(base,ex.until),to]);
      }else intervals.push([base,to]);
    }
  }
  intervals.sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for(const interval of intervals){
    const last=merged.at(-1);
    if(last && interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);
    else merged.push([...interval]);
  }
  const current=merged.find(([from,to])=>now>=from && now<to);
  return { timezone: rule.timezone, blocked:!!current,
    ...(rule.scoped_weekly_exemption?{scoped_exception_id:rule.scoped_weekly_exemption.id,exception_valid_until:rule.scoped_weekly_exemption.until}:{}),
    next_eligible_at:current?current[1]:now,
    next_block_at:merged.find(([from])=>from>(current?current[1]:now))?.[0] };

}
