export function seconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string') throw new Error('Timestamps must be seconds or HH:MM:SS.mmm.');
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  const parts = value.trim().replace(',', '.').split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) throw new Error(`Invalid timestamp: ${value}`);
  const nums = parts.map(Number);
  if (nums.slice(1).some(n => n >= 60) || nums.slice(0, -1).some(n => !Number.isInteger(n))) throw new Error(`Invalid timestamp: ${value}`);
  return nums.reduce((a, n) => a * 60 + n, 0);
}

export function parseText(text, episode = 'Episode 1') {
  if (text.includes('--- SCRIPT START ---')) return parseKuku(text, episode);
  const records = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*\[?([\d:.,]+)\s*(?:-->|-|–)\s*([\d:.,]+)\]?\s+(.+)$/);
    if (!m) throw new Error(`Line ${i + 1}: expected [00:00 - 00:05] screenplay text. Every line needs an explicit end time.`);
    records.push({ episode, start: m[1], end: m[2], text: m[3] });
  }
  return records;
}

export function parseKuku(text, fallback) {
  const episode = text.match(/^EPISODE NUMBER:\s*(.+)$/m)?.[1].trim() || fallback;
  const pattern = /\*\*([^\n]+?)\*\*\s*\nStart:\s*\(([\d:.]+)\)\s*\|\s*End:\s*\(([\d:.]+)\)\s*\n([\s\S]*?)(?=\n\s*\*\*|\nSCENE \d|\n--- SCRIPT END ---|$)/g;
  const rows = [...text.matchAll(pattern)].map(m => ({ episode, start: m[2], end: m[3], text: `${m[1].replace(/:$/, '')}: ${m[4].trim()}` }));
  const expected = [...text.matchAll(/^Start:\s*\(/gm)].length;
  if (!rows.length || rows.length !== expected) throw new Error(`${episode}: parsed ${rows.length} of ${expected} timed blocks. Inspect the source format before proceeding.`);
  return rows;
}

export function normalize(input) {
  let rows = input;
  if (!Array.isArray(rows)) {
    if (Array.isArray(input?.episodes)) rows = input.episodes.flatMap(e => {
      if (!Array.isArray(e.records)) throw new Error('Each episode needs a records array.');
      return e.records.map(r => ({ ...r, episode: e.episode ?? e.id ?? e.title }));
    });
    else rows = input?.records;
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('Provide a nonempty records array.');
  if (rows.length > 10000) throw new Error('Limit: 10,000 records per run. Split larger shows into batches.');
  const episodes = new Map();
  const ids = new Set();
  const records = rows.map((row, i) => {
    if (!row || typeof row !== 'object') throw new Error(`Record ${i + 1} must be an object.`);
    const episode = String(row.episode ?? '').trim();
    const text = String(row.text ?? '').trim();
    if (!episode || episode.length > 100 || !text || text.length > 4000) throw new Error(`Record ${i + 1}: episode and text are required (100 / 4,000 character limits).`);
    const start = seconds(row.start), end = seconds(row.end);
    if (end <= start || end > 86400) throw new Error(`Record ${i + 1}: end must follow start and be within 24 hours.`);
    const id = String(row.id ?? `r${String(i + 1).padStart(5, '0')}`);
    if (!/^[\w.-]{1,80}$/.test(id) || ids.has(id)) throw new Error(`Record ${i + 1}: source IDs must be unique, short letters/numbers/dashes.`);
    ids.add(id);
    const record = { id, episode, start, end, text };
    if (!episodes.has(episode)) episodes.set(episode, []);
    episodes.get(episode).push(record);
    return record;
  });
  if (episodes.size > 50) throw new Error('Limit: 50 episodes per run.');
  for (const [episode, list] of episodes) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  return { records, episodes };
}

export function resolveSegments(candidate, source) {
  if (!Array.isArray(candidate?.segments) || candidate.segments.length < 1 || candidate.segments.length > 3) throw new Error('A promo needs 1–3 ordered segments.');
  const seen = new Map();
  const segments = candidate.segments.map(s => {
    const list = source.episodes.get(s.episode);
    if (!list) throw new Error('Unknown source episode.');
    const first = list.findIndex(r => r.id === s.startId), last = list.findIndex(r => r.id === s.endId);
    if (first < 0 || last < first) throw new Error('Unknown or reversed source record IDs.');
    const start = list[first].start, end = list[last].end;
    if (end <= start) throw new Error('Segment end must follow start.');
    const records = list.filter(r => r.start < end && r.end > start);
    for (const [a, b] of seen.get(s.episode) ?? []) if (start < b && end > a) throw new Error('Segments repeat or overlap source footage.');
    seen.set(s.episode, [...(seen.get(s.episode) ?? []), [start, end]]);
    return { episode: s.episode, startId: s.startId, endId: s.endId, start, end, duration: +(end - start).toFixed(3), records, before: list.filter(r => r.end <= start).at(-1) ?? null, after: list.find(r => r.start >= end) ?? null };
  });
  const duration = +segments.reduce((n, s) => n + s.duration, 0).toFixed(3);
  if (duration < 20 || duration > 60) throw new Error(`Duration ${duration}s is outside 20–60 seconds.`);
  return { segments, duration };
}
