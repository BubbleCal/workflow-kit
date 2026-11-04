import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};
const normalize = value => String(value ?? '').trim().normalize('NFKC').toLowerCase();
const items = state => Array.isArray(state?.items) ? state.items : Object.values(state?.items ?? {});
const pending = item => !['resolved', 'cancelled', 'canceled', 'superseded', 'closed'].includes(item.status);
const reference = value => {
  const match = /^([TD])-?0*(\d+)$/i.exec(String(value ?? '').trim());
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) return null;
  return `${match[1].toUpperCase()}-${String(Number(match[2])).padStart(3, '0')}`;
};
export function taskId(value) {
  const id = reference(value);
  if (!id?.startsWith('T-')) throw new Error('A canonical parent T task is required');
  return id;
}
export function readDecisionState(base = root) {
  const path = resolve(base, 'decisions.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { items: [] };
}

// This prepares data for the coordinator, never writes the decision/task store.
export function prepareQuestion(input, state) {
  const task = taskId(input.task_id), dedup = required(input.dedup_key, 'dedup_key');
  const old = items(state).filter(d => taskId(d.task_id) === task && d.dedup_key === dedup);
  if (old.length > 1) throw new Error('Duplicate durable question identity needs reconciliation');
  if (old.length) return { existing: true, record: structuredClone(old[0]), state_written: false };
  if (input.id || input.legacy_aliases) throw new Error('New questions use a private generated identity, not a D sequence');
  const id = `question:${createHash('sha256').update(JSON.stringify([task, dedup])).digest('hex').slice(0, 32)}`;
  return { existing: false, state_written: false, record: {
    ...input, id, task_id: task, dedup_key: dedup,
    subject: required(input.subject, 'question subject'), question: required(input.question, 'question'),
    evidence_ref: required(input.evidence_ref, 'question evidence'), status: 'unresolved',
  } };
}

export function taskDisplayText(text, state, { rejectUnknown = false } = {}) {
  const aliases = new Map();
  for (const d of items(state)) for (const alias of [d.id, ...(d.legacy_aliases ?? [])]) {
    const id = reference(alias); if (id?.startsWith('D-')) aliases.set(id, taskId(d.task_id));
  }
  // Keep URLs and machine keys intact. Only the presentation changes; raw mail,
  // source text, aliases and deduplication keys remain byte-for-byte historical.
  return String(text).replace(/https?:\/\/[^\s)>]+|(?<![\w:/])D-?0*\d+(?![\w:/-])/gi, token => {
    if (/^https?:/i.test(token)) return token;
    const task = aliases.get(reference(token));
    if (!task && rejectUnknown) throw new Error('Unknown D label; register the question under its parent T task');
    return task ?? token;
  });
}

export function questionView(item, state) {
  const task = taskId(item.task_id), subject = item.subject ?? item.question;
  return { task_id: task, status: item.status, subject: taskDisplayText(subject, state),
    title: `${task} · 待你决定：${taskDisplayText(subject, state)}`,
    question: taskDisplayText(item.question, state), recommendation: item.recommendation ? taskDisplayText(item.recommendation, state) : null,
    alternatives: (item.alternatives ?? item.options ?? []).map(o => typeof o === 'string' ? taskDisplayText(o, state) :
      { ...o, ...(o.label ? { label: taskDisplayText(o.label, state) } : {}) }),
    waiting_impact: item.waiting_impact ? taskDisplayText(item.waiting_impact, state) : null };
}
export function pendingQuestions(state) { return items(state).filter(pending).map(d => questionView(d, state)); }

export function resolveReply(input, state) {
  const all = items(state), ref = input.reference ? reference(input.reference) : null;
  if (input.reference && !ref) return { status: 'unknown_reference', state_written: false };
  let candidates = all;
  if (ref?.startsWith('D-')) {
    candidates = all.filter(d => [d.id, ...(d.legacy_aliases ?? [])].some(a => reference(a) === ref));
  } else if (ref) candidates = all.filter(d => taskId(d.task_id) === ref);
  if (input.question_key) candidates = candidates.filter(d => d.id === input.question_key);
  if (input.context_message_id) candidates = candidates.filter(d =>
    [d.source_message_id, d.question_message_id, d.notification_message_id, ...(d.context_message_ids ?? [])].includes(input.context_message_id));
  if (input.subject) {
    const subject = normalize(input.subject);
    candidates = candidates.filter(d => normalize(d.subject ?? d.question).includes(subject));
  }
  if (ref?.startsWith('D-') && candidates.length === 1 && !pending(candidates[0]))
    return { status: 'already_resolved', task_id: taskId(candidates[0].task_id), question_key: candidates[0].id, state_written: false };
  candidates = candidates.filter(pending);
  if (candidates.length > 1 && input.option) {
    const option = normalize(input.option);
    candidates = candidates.filter(d => (d.options ?? d.alternatives ?? []).some(o =>
      (typeof o === 'string' ? [o] : [o.id, o.label, o.value]).some(v => normalize(v) === option)));
  }
  if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous' : 'no_pending_match',
    candidates: candidates.map(d => ({ task_id: taskId(d.task_id), subject: d.subject ?? d.question })), state_written: false };
  const d = candidates[0];
  return { status: 'matched', task_id: taskId(d.task_id), question_key: d.id, subject: d.subject ?? d.question,
    state_written: false, authorization_granted: false };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')), state = readDecisionState();
    const output = input.op === 'view' ? { items: pendingQuestions(state), state_written: false } :
      input.op === 'prepare_question' ? prepareQuestion(input.question, state) :
      input.op === 'resolve_reply' ? resolveReply(input.reply, state) :
      input.op === 'render_text' ? { text: taskDisplayText(input.text, state), state_written: false } : null;
    if (!output) throw new Error('Use view, prepare_question, resolve_reply or render_text');
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); process.exitCode = 1; }
}
