// One source catalog, referenced by IDs, instead of repeating full records for every cut.
export function compactCandidates(payload) {
  const records = new Map();
  const segment = s => {
    for (const r of [...s.records, s.before, s.after].filter(Boolean)) records.set(r.id, r);
    return { episode:s.episode, startId:s.startId, endId:s.endId, start:s.start, end:s.end, recordIds:s.records.map(r=>r.id), beforeId:s.before?.id ?? null, afterId:s.after?.id ?? null };
  };
  const candidates = payload.candidates.map(c => ({
    id:c.id, title:c.title, duration:c.duration, segments:c.segments.map(segment),
    eligibleHookIds:c.segments[0].records.filter(r=>r.start>=c.segments[0].start && r.start-c.segments[0].start<=3).map(r=>r.id),
    ...(c.endingOptions ? { endingOptions:c.endingOptions.map(o=>({
      endId:o.endId, duration:o.duration, segments:o.segments.map(segment),
    })) } : {}),
  }));
  return { candidates, sourceRecords:[...records.values()] };
}
