import { resolveSegments } from './input.js';

export const endingStrategies = ['before_reveal', 'on_reveal', 'reaction', 'confrontation', 'consequences_pending', 'resolved'];

// Offer a bounded local comparison without adding another model call.
export function endingOptions(candidate, source) {
  const last = candidate.segments.at(-1);
  const list = source.episodes.get(last.episode);
  const anchors = list.filter(r => !/^(CAMERA|SOUND FX|SFX|MUSIC):/i.test(r.text) && Math.abs(r.end - last.end) <= 8 && r.end !== last.end);
  const options = [{ endId: last.endId, duration: candidate.duration, segments: candidate.segments }];
  for (const direction of [-1, 1]) {
    const nearby = anchors.filter(r => Math.sign(r.end - last.end) === direction).sort((a,b) => Math.abs(a.end - last.end) - Math.abs(b.end - last.end));
    for (const record of nearby) {
      try {
        const segments = candidate.segments.map((s,i) => ({ episode: s.episode, startId: s.startId, endId: i === candidate.segments.length - 1 ? record.id : s.endId }));
        const resolved = resolveSegments({ segments }, source);
        options.push({ endId: record.id, ...resolved });
        break;
      } catch { /* Not a legal cut: try the next nearby boundary. */ }
    }
  }
  return options;
}

export function selectEnding(candidate, review) {
  const option = candidate.endingOptions.find(o => o.endId === review?.selectedEndId);
  if (!option) throw new Error('Critic selected an ending outside the supplied legal options.');
  if (!endingStrategies.includes(review.endingStrategy)) throw new Error('Unknown ending strategy.');
  if (typeof review.cutReason !== 'string' || !review.cutReason.trim() || review.cutReason.length > 2000) throw new Error('Ending decision needs a viewer question and a cut explanation.');
  if (review.cliffhanger >= 3 && review.endingStrategy === 'resolved') throw new Error('A qualifying ending needs a specific unresolved viewer question.');
  // cutReason already explains the winner when the model lists only the losing alternatives.
  if (Array.isArray(review.alternativeCuts) && !review.alternativeCuts.some(c => c?.endId === option.endId)) {
    review.alternativeCuts = [...review.alternativeCuts, { endId:option.endId, reason:review.cutReason }];
  }
  const comparisons = review.alternativeCuts;
  if (!Array.isArray(comparisons) || comparisons.length !== candidate.endingOptions.length || new Set(comparisons.map(c => c.endId)).size !== comparisons.length || comparisons.some(c => !candidate.endingOptions.some(o => o.endId === c.endId) || typeof c.reason !== 'string' || !c.reason.trim() || c.reason.length > 1000)) throw new Error('Critic must explain every supplied ending option exactly once.');
  return { ...candidate, originalEndId: candidate.segments.at(-1).endId, segments: option.segments, duration: option.duration };
}
