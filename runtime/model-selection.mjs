import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readModelSelection() {
  const path = fileURLToPath(new URL('../instance.json', import.meta.url));
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).models?.roles?.execution ?? null : null;
}

export function withCreationModel(kind, payload, selection) {
  if (kind !== 'create_thread' || !selection) return payload;
  if (!selection.source_message_id || !selection.model || !selection.thinking)
    throw new Error('Creation model preference requires an actual source, model and effort');
  const field = payload.native ? 'native' : payload.tool_args ? 'tool_args' : null;
  if (!field) throw new Error('Creation model preference requires supported native arguments');
  // Fast is a separate native tier. The current tool does not expose that field;
  // recording the request here must never be reported as applying it.
  return { ...payload, model_selection: { ...selection }, [field]: {
    ...payload[field], model: payload[field].model ?? selection.model,
    thinking: payload[field].thinking ?? selection.thinking,
  } };
}
