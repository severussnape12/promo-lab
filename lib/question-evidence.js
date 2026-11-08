export function eligibleQuestionRecord(record, segment) {
  return record.start >= segment.start && record.end <= segment.end &&
    !/^(?:CAMERA|MUSIC|SOUND(?: FX)?|SFX|TRANSITION)\s*:/i.test(record.text);
}

function readDraft(draft, eligible) {
  const question = draft?.question?.trim();
  if (typeof question !== 'string' || question.length > 220 || !/^[^?]+\?$/.test(question)) {
    return { issue:'Write one short, complete question.' };
  }
  const ids = draft.evidenceIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length ||
      ids.some(id => !eligible.has(id))) {
    return { issue:'Cite one to three distinct eligible records from this cut.' };
  }
  if (/^what happens (?:next |immediately )?after\b|^what does the speaker mean\b/i.test(question)) {
    return { issue:'Ask about the specific unresolved stakes in conversational language.' };
  }
  if (/\b(?:I|my|mine|we|our)\b/i.test(question) || /[.!;]\s+\S/.test(question)) {
    return { issue:'Write only the viewer’s question about the character, without a first-person line or a sentence of setup.' };
  }
  return { question, evidence:ids.map(id=>eligible.get(id)) };
}

// A character can supply the uncertainty directly. Translate only unambiguous
// first-person questions; leave pronouns, modals and complex syntax to the writer.
function spokenFear(record) {
  const match = /^([^:(]+?)(?:\s*\([^)]*\))?:\s*["“]?What if I ([a-z][a-z '-]*)\?["”]?$/i.exec(record.text.trim());
  if (!match || /\b(?:you|your|I|my|me|we|our)\b/i.test(match[2]) ||
      /^(?:am|was|can't|cannot|could|would|don't|never|have been)\b/i.test(match[2])) return null;
  const speaker = match[1].trim().toLowerCase().replace(/\b\w/g,c=>c.toUpperCase());
  return { id:record.id, question:`Is ${speaker} going to ${match[2]}?` };
}

export async function groundQuestion(candidate, review, generate, acceptResult) {
  review.viewerQuestion = '';
  review.questionEvidence = [];
  review.questionEvidenceIds = [];
  const segments = candidate.segments.map(s => ({
    episode:s.episode, start:s.start, end:s.end,
    records:s.records.filter(r=>r.start >= s.start && r.end <= s.end),
  }));
  const eligible = new Map();
  for (const s of segments) for (const r of s.records) {
    if (eligibleQuestionRecord(r,s)) eligible.set(r.id,r);
  }
  if (!eligible.size || review.cliffhanger < 3 || review.endingStrategy === 'resolved') {
    review.cliffhanger = Math.min(review.cliffhanger,2);
    return;
  }

  const fears = [...eligible.values()].map(spokenFear).filter(Boolean);
  if (fears.length) {
    const choice = await generate('spokenFear',{segments,options:fears});
    if (choice.id !== null) {
      const fear = fears.find(option=>option.id === choice.id);
      if (!fear) throw new Error('Unknown source for the spoken fear.');
      review.viewerQuestion = fear.question;
      review.questionEvidence = [eligible.get(fear.id)];
      review.questionEvidenceIds = [fear.id];
      acceptResult(choice);
      return;
    }
    acceptResult(choice);
  }

  let issue;
  for (let attempt=0; attempt<2; attempt++) {
    const spokenQuestions = [...eligible.values()].filter(record => record.text.includes('?')).map(record=>record.id);
    const draft = await generate('questionPick', {segments,eligibleIds:[...eligible.keys()], spokenQuestions, ...(issue ? {revision:issue} : {})});
    if (draft?.question === null) { issue='No meaningful unanswered question at this cut.'; break; }
    const parsed = readDraft(draft,eligible);
    if (parsed.issue) { issue=parsed.issue; continue; }

    // The verifier cannot borrow facts from uncited lines elsewhere in the episode.
    const verdict = await generate('questionProof',{question:parsed.question,evidence:parsed.evidence});
    if (typeof verdict?.supported !== 'boolean' || typeof verdict?.natural !== 'boolean' ||
        typeof verdict?.answered !== 'boolean' || typeof verdict?.central !== 'boolean' ||
        typeof verdict?.reason !== 'string' || !verdict.reason.trim()) {
      throw new Error('Invalid viewer-question verification response.');
    }
    acceptResult(verdict);
    if (verdict.supported && verdict.natural && !verdict.answered && verdict.central) {
      review.viewerQuestion = parsed.question;
      review.questionEvidence = parsed.evidence;
      review.questionEvidenceIds = parsed.evidence.map(r=>r.id);
      acceptResult(draft);
      return;
    }
    issue = verdict.reason.slice(0,500);
  }
  review.cliffhanger = 0;
  review.needsReview = true;
  review.risks.push('No verified viewer question: ' + issue);
}
