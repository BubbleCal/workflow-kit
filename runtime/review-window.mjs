import { readFileSync } from 'node:fs';

export const REVIEW_WINDOW = Object.freeze({ timezone: 'Asia/Shanghai', blocked_start_inclusive: '04:00:00', blocked_end_exclusive: '12:00:00' });
export const isReviewDelivery = kind => ['slack_pr', 'pr_ready'].includes(kind);
export function withReviewWindowGuidance(kind, payload) {
  if (!['dispatch','create_thread'].includes(kind)) return payload;
  const marker = '[workflow-pr-review-window:v1]';
  const guidance = marker + '\nEvery day in Asia/Shanghai, do not send PRs for review from 04:00 inclusive to 12:00 exclusive. Continue implementation, tests, repairs and internal review. Create new PRs as drafts; route review-intended draft-to-ready transitions and canonical Slack URL delivery to the existing coordinator using control kind=pr_ready/slack_pr and authorize_review_send immediately before the external operation. Preserve deferred work until the existing coordinator rechecks the current head/readiness/receipts at or after noon. Do not bypass via direct non-draft creation, other channels, comments or reviewer requests; do not create a timer or restart healthy work.';
  const append = text => text.includes(marker) ? text : text + '\n\n' + guidance;
  return { ...payload, review_window_guidance_version: 1,
    ...(typeof payload.prompt === 'string' ? { prompt: append(payload.prompt) } : {}),
    ...(typeof payload.native?.prompt === 'string' ? { native: { ...payload.native, prompt: append(payload.native.prompt) } } : {}) };
}
export function readReviewWindow() {
  return JSON.parse(readFileSync(new URL('../pr-review-window.json', import.meta.url), 'utf8'));
}
export function reviewWindowAt(now, rule = REVIEW_WINDOW) {
  if (!Number.isFinite(now) || Object.entries(REVIEW_WINDOW).some(([key,value]) => rule?.[key] !== value))
    throw new Error('Missing or unsupported persisted PR review window');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: rule.timezone,
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' })
    .formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type,Number(x.value)]));
  const {year,month,day,hour,minute,second} = parts;
  const offset = Date.UTC(year,month-1,day,hour,minute,second) - Math.floor(now / 1000) * 1000;
  const blocked = hour >= 4 && hour < 12;
  return { timezone: rule.timezone, blocked, next_eligible_at: blocked ? Date.UTC(year,month-1,day,12)-offset : now,
    next_block_at: Date.UTC(year,month-1,day+(hour>=12?1:0),4)-offset };
}
