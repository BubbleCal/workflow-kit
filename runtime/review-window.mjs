import { readFileSync } from 'node:fs';

export const REVIEW_WINDOW = Object.freeze({ timezone: 'Asia/Shanghai', blocked_start_inclusive: '03:00:00', blocked_end_exclusive: '10:00:00' });
export const isReviewDelivery = kind => ['slack_pr', 'pr_ready'].includes(kind);
export function withReviewWindowGuidance(kind, payload, prior) {
  if (!['dispatch','create_thread'].includes(kind)) return payload;
  const version = prior?.review_window_guidance_version ?? 2;
  const marker = `[workflow-pr-review-window:v${version}]`;
  const original = prior?.prompt ?? prior?.native?.prompt;
  const saved = typeof original === 'string' && original.includes(marker) ? original.slice(original.lastIndexOf(marker)) : null;
  const rule = readReviewWindow();
  reviewWindowAt(Date.now(),rule);
  const guidance = saved ?? marker + `\nEvery day in ${rule.timezone}, do not send PRs for review from ${rule.blocked_start_inclusive.slice(0,5)} inclusive to ${rule.blocked_end_exclusive.slice(0,5)} exclusive. Continue implementation, tests, repairs and internal review. Create new PRs as drafts; the original task owner performs authorized review-intended draft-to-ready transitions and canonical Slack URL delivery using control kind=pr_ready/slack_pr and authorize_review_send immediately before the external operation. Preserve deferred work until the original owner rechecks the current head/readiness/CI/Gatekeeper/receipts after the saved window opens. Do not bypass via direct non-draft creation, other channels, comments or reviewer requests; do not create a timer or restart healthy work.`;
  const append = text => text.includes(marker) ? text : text + '\n\n' + guidance;
  return { ...payload, review_window_guidance_version: version,
    ...(typeof payload.prompt === 'string' ? { prompt: append(payload.prompt) } : {}),
    ...(typeof payload.native?.prompt === 'string' ? { native: { ...payload.native, prompt: append(payload.native.prompt) } } : {}) };
}
export function readReviewWindow() {
  return JSON.parse(readFileSync(new URL('../pr-review-window.json', import.meta.url), 'utf8'));
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
  const local=hour*3600+minute*60+second, blocked = local >= start && local < end;
  return { timezone: rule.timezone, blocked, next_eligible_at: blocked ? Date.UTC(year,month-1,day,0,0,end)-offset : now,
    next_block_at: Date.UTC(year,month-1,day+(local>=end?1:0),0,0,start)-offset };
}
