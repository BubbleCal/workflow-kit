// Keep source payloads durable while making routine discovery output proportional
// to the unfinished work. Full pages remain available through explicit reads.
export function compactDiscoveryBatch(batch, sources = []) {
  if (!batch) return batch;
  const {pages = [], prompt, ...rest} = batch;
  const streams = new Map();
  for (const page of pages) {
    const key = `${page.source_id}:${page.request_index}`;
    const prior = streams.get(key);
    streams.set(key, {source_id: page.source_id, request_index: page.request_index,
      last_page_key: page.page_key, page_count: (prior?.page_count ?? 0) + 1, complete: page.data.complete,
      next_cursor: page.data.next_cursor ?? null, evidence_ref: page.data.evidence_ref,
      observation_count: (prior?.observation_count ?? 0) + (page.data.observations?.length ?? 0)});
  }
  const snapshot = {...rest.snapshot, sources: rest.snapshot.sources.map(source => {
    const current = sources.find(s => s.source_id === source.source_id);
    return current ? {...source, interval_ms: current.interval_ms, health: current.health,
      coverage_complete: current.last_success_at !== null && current.last_success_at >= Date.parse(source.window.to)} : source;
  })};
  return {...rest, snapshot, streams: [...streams.values()], stored_page_count: pages.length,
    detail_hint: 'Use discovery page with page_key or discovery pending for unclassified evidence. Raw pages are retained.'};
}
export function nextDiscoverySlot(at, interval, aligned) {
  return aligned ? (Math.floor(at / interval) + 1) * interval : at + interval;
}
