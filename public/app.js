import { normalize, parseText } from './input.js';
const $ = selector => document.querySelector(selector);
let source = null, report = null, selectedId = null, tab = 'shortlist', events = [], controller = null, busy = false;
let status = { modelConfigured: false }, sourceLabel = '';
const feedback = {};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const time = n => { const h = Math.floor(n / 3600); return `${h ? `${String(h).padStart(2,'0')}:` : ''}${String(Math.floor(n / 60) % 60).padStart(2,'0')}:${(n % 60).toFixed(2).padStart(5,'0')}`; };
const label = s => ({ 'needs-review':'Needs review', shortlisted:'Shortlisted', rejected:'Rejected', duplicate:'Similar cut' }[s] || s);
function notice(message) { $('#notice').textContent = message; }
function resetResults() {
  report = null; selectedId = null; events = [];
  for (const key of Object.keys(feedback)) delete feedback[key];
  $('#export').disabled = true; $('#export-trace').disabled = true;
  $('#short-count').textContent = 0;
  $('#results-summary').innerHTML = '<div><strong>—</strong><span>PROMOS</span></div><div><strong>—</strong><span>EPISODES</span></div><div><strong>20–60<span>s</span></strong><span>CLIP LENGTH</span></div>';
  $('#trace-events').replaceChildren(); $('#trace-count').textContent = '0 events'; $('#trace-last').textContent = 'Ready when you are';
  document.querySelectorAll('[data-agent]').forEach(el => el.classList.remove('running','completed','failed'));
  renderList(); renderDetail();
}
function load(rows, name) {
  if (busy) return;
  const next = normalize(rows);
  source = next; sourceLabel = name;
  resetResults();
  $('#source-meta').innerHTML = `<strong>${next.episodes.size} episodes · ${next.records.length.toLocaleString()} records</strong><br>${escape(name)}`;
  $('#episode-select').innerHTML = [...next.episodes.keys()].map(e => `<option>${escape(e)}</option>`).join('');
  $('#episode-select').disabled = false;
  renderSource(); updateRun(); notice('Source loaded. Original timestamps preserved.');
}
function renderSource() {
  const rows = source?.episodes.get($('#episode-select').value) ?? [];
  $('#source-preview').innerHTML = rows.map(r => `<div class="source-row"><time>${time(r.start)} → ${time(r.end)} · ${escape(r.id)}</time>${escape(r.text)}</div>`).join('');
}
async function importFiles(files) {
  if (busy) return;
  try {
    const selected = [...files].filter(f => /\.(txt|json)$/i.test(f.name)).sort((a,b) => a.name.localeCompare(b.name));
    if (!selected.length) throw new Error('Choose TXT or JSON screenplay files.');
    if (selected.reduce((n,f) => n+f.size,0) > 3000000) throw new Error('Files exceed the 3 MB input budget. Split into smaller batches.');
    const rows = [];
    for (const file of selected) {
      const text = await file.text();
      if (/\.json$/i.test(file.name)) {
        const normalized = normalize(JSON.parse(text));
        // Regenerate IDs across files to avoid collisions in independent episode exports.
        rows.push(...normalized.records.map(({ id, ...r }) => r));
      } else rows.push(...parseText(text, file.name.replace(/\.txt$/i,'')));
    }
    load(rows, `${selected.length} imported file${selected.length === 1 ? '' : 's'} · private to this run`);
  } catch (e) { notice(`Import failed: ${e.message}`); }
}
function updateRun() {
  const needsToken = $('#mode').value === 'model' && status.tokenRequired;
  $('#token-field').hidden = !needsToken;
  $('#run').disabled = busy || !source || ($('#mode').value === 'model' && !status.modelConfigured) || (needsToken && !$('#token').value.trim());
  $('#mode').disabled = busy;
  $('#stitch').disabled = busy || $('#mode').value !== 'model';
  $('#model-note').textContent = $('#mode').value === 'baseline' ? 'Keyword discovery. No API calls. All picks need an editor.' : status.modelConfigured ? `Using ${status.model}. Sends screenplay excerpts to your configured provider.` : 'Set MODEL_API_KEY and MODEL_NAME in .env, then restart the server.';
  for (const id of ['sample-button','local-pack','paste-button','files','folder','folder-button']) $(`#${id}`).disabled = busy;
  $('#cancel').hidden = !busy;
  $('#run').innerHTML = busy ? 'Agents are working… <span>◌</span>' : 'Find promos <span>→</span>';
}
function addEvent(event) {
  events.push(event); $('#export-trace').disabled = false;
  $('#trace-count').textContent = `${events.length} events`;
  $('#trace-last').textContent = event.message ?? `${event.agent}: ${event.status}`;
  const indicator = document.querySelector(`[data-agent="${event.agent}"]`);
  if (indicator) { indicator.classList.remove('running','completed','failed'); indicator.classList.add(event.status === 'started' ? 'running' : event.status); }
  const row = document.createElement('details'); row.className = 'trace-event';
  const summary = document.createElement('summary'); summary.textContent = `${String(events.length).padStart(3,'0')}  ${event.agent ?? 'system'} / ${event.status ?? event.type}  ${event.message ?? event.tool ?? ''}`;
  const pre = document.createElement('pre');
  row.append(summary, pre); row.addEventListener('toggle', () => { if (row.open && !pre.textContent) pre.textContent = JSON.stringify(event,null,2); });
  $('#trace-events').append(row);
}
async function run() {
  if (!source || busy) return;
  resetResults(); busy = true; controller = new AbortController(); updateRun();
  notice('Master agent is coordinating the run. Follow the activity log below.');
  try {
    const headers = { 'Content-Type':'application/json' };
    if ($('#mode').value === 'model' && $('#token').value) headers.Authorization = `Bearer ${$('#token').value}`;
    const response = await fetch('/api/run', { method:'POST', headers, body:JSON.stringify({ records:source.records, mode:$('#mode').value, stitch:$('#stitch').checked }), signal:controller.signal });
    if (!response.ok) throw new Error((await response.text()).slice(0,1000));
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    const consume = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message);
      if (event.type === 'result') { report = event.report; return; }
      addEvent(event);
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) { pending += decoder.decode(); if (pending.trim()) consume(pending); break; }
      pending += decoder.decode(value, { stream:true });
      const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(consume);
    }
    if (!report) throw new Error('The connection ended without a final report. Export the trace to investigate.');
    selectedId = report.candidates.find(c => c.rank === 1)?.id ?? report.candidates[0]?.id;
    $('#export').disabled = false;
    $('#short-count').textContent = report.summary.ranked;
    $('#results-summary').innerHTML = `<div><strong>${report.summary.ranked}</strong><span>PROMOS</span></div><div><strong>${report.summary.episodes}</strong><span>EPISODES</span></div><div><strong>${(report.summary.elapsedMs / 1000).toFixed(1)}<span>s</span></strong><span>RUN TIME</span></div>`;
    notice(`${report.mode === 'baseline' ? 'Offline baseline complete. Every pick needs human review.' : 'Model run complete. Verify each pick against the footage.'}${report.mode === 'model' ? ` ${report.usage.cacheHits ?? 0} cache hits · ${report.usage.fallbackSwitches ?? 0} provider switches.` : ''}${report.summary.partial ? ` ${report.summary.failures} failures — check coverage.` : ''}`);
    renderList(); renderDetail();
  } catch (e) {
    notice(e.name === 'AbortError' ? 'Run cancelled. Partial trace is available; no final ranking was produced.' : `Run failed: ${e.message}`);
    addEvent({ type:'error', agent:'master', status:'failed', message:e.name === 'AbortError' ? 'Cancelled by editor.' : e.message });
    document.querySelectorAll('[data-agent].running').forEach(el => { el.classList.remove('running'); el.classList.add('failed'); });
  } finally { busy = false; updateRun(); }
}
function renderList() {
  if (!report) {
    $('#candidate-list').innerHTML = '<div class="empty-state"><div class="empty-art"><span>00:03</span><b>▶</b><span>00:60</span></div><h3>Great stories have a moment.</h3><p>Load your screenplay and let the team find it.<br>You make the final editorial call.</p><div class="empty-chips"><span>Evidence, not guesses</span><span>Every cut explained</span></div></div>'; return;
  }
  if (tab === 'coverage') {
    $('#candidate-list').innerHTML = `<div class="source-meta"><strong>${report.coverage.filter(c => c.status === 'completed').length}/${report.summary.episodes} episodes searched</strong><br>${report.summary.proposed} valid proposals · ${report.summary.reviewed} reviewed</div>` + report.coverage.map(c => `<div class="coverage-row"><strong>${escape(c.episode)}</strong><span>${c.status === 'completed' ? `${c.proposed} proposed` : `FAILED: ${escape(c.error)}`}</span></div>`).join('') + report.failures.map(f => `<div class="failure-box"><strong>${escape(f.agent)} · ${escape(f.episode ?? f.candidateId ?? '')}</strong><br>${escape(f.reason)}</div>`).join(''); return;
  }
  const candidates = tab === 'shortlist' ? report.candidates.filter(c => c.rank) : report.candidates;
  $('#candidate-list').innerHTML = (report.summary.partial ? '<div class="failure-box">This run has failures. See Coverage for missing episodes or reviews.</div>' : '') + (candidates.length ? candidates.map(c => `<button class="candidate ${selectedId === c.id ? 'selected' : ''}" data-id="${escape(c.id)}"><div class="candidate-top"><span class="rank">${c.rank ? `#${String(c.rank).padStart(2,'0')}` : '—'} / ${escape(c.id)}</span><span class="badge ${escape(feedback[c.id]?.decision === 'approved' ? 'approved' : c.status)}">${escape(feedback[c.id]?.decision ?? label(c.status))}</span></div><h3>${escape(c.title)}</h3><div class="candidate-meta">${escape(c.segments.map(s => s.episode).join(' + '))} · ${c.duration.toFixed(1)}s · ${c.segments.length > 1 ? `${c.segments.length} segments` : 'Continuous'}</div><p class="candidate-quote">${escape(c.review.hookText.slice(0,145))}${c.review.hookText.length > 145 ? '…' : ''}</p><div class="candidate-bottom"><span>Editorial score <span class="score-track"><i style="width:${c.score}%"></i></span></span><strong>${c.score}<span> / 100</span></strong></div></button>`).join('') : '<div class="empty-state"><h3>No qualifying promos.</h3><p>Inspect all candidates and coverage to see why.<br>A valid run can return no strong choices.</p></div>');
  $('#candidate-list').querySelectorAll('[data-id]').forEach(el => el.addEventListener('click', () => { selectedId = el.dataset.id; renderList(); renderDetail(); if (innerWidth < 1200) $('.detail-panel').scrollIntoView({ behavior:'smooth', block:'start' }); }));
}
function renderDetail() {
  const c = report?.candidates.find(c => c.id === selectedId);
  if (!c) { $('#detail').innerHTML = '<div class="detail-empty"><span>⌁</span><h3>No mystery cuts.</h3><p>Select a promo to see its source segments, hook, ending and the reasoning behind its rank.</p></div>'; return; }
  const r = c.review, f = feedback[c.id] ?? {};
  $('#detail').innerHTML = `<span class="badge ${c.status}">${escape(label(c.status))}</span><h3 class="detail-title">${escape(c.title)}</h3><div class="detail-subtitle">${c.duration.toFixed(2)} seconds · ${c.segments.length} segment${c.segments.length > 1 ? 's' : ''} · ${report.mode === 'baseline' ? 'Offline heuristic' : 'Model judgment'}</div>
    <div class="detail-label">THE HOOK / FIRST 3 SECONDS</div><blockquote class="evidence">${escape(r.hookText)}<small>Source ${escape(r.hookId)}</small></blockquote>
    <div class="detail-label">THE CLIFFHANGER / CUT HERE</div><blockquote class="evidence">${escape(r.cliffhangerText)}<small>Source ${escape(r.cliffhangerId)}</small></blockquote>
    ${r.endingStrategy ? `<div class="detail-label">ENDING STRATEGY / ${escape(r.endingStrategy.replaceAll('_',' '))}</div><blockquote class="evidence">${escape(r.viewerQuestion || 'No meaningful unresolved question identified.')}</blockquote>${r.questionEvidence?.length ? '<div class="detail-label">EVIDENCE FOR THIS QUESTION</div>' + r.questionEvidence.map(line => `<blockquote class="evidence">${escape(line.text)}<small>${escape(line.episode)} · ${time(line.start)} → ${time(line.end)} · ${escape(line.id)}</small></blockquote>`).join('') : ''}<p class="why">${escape(r.cutReason)}</p><details class="segment"><summary>Compare ending choices${c.originalEndId !== r.selectedEndId ? ' · cut changed' : ''}</summary>${r.alternativeCuts.map(a => { const option = c.endingOptions.find(o => o.endId === a.endId); return `<div class="source-row"><time>${time(option.segments.at(-1).end)} · ${escape(a.endId)}${a.endId === r.selectedEndId ? ' · SELECTED' : ''}</time>${escape(a.reason)}</div>`; }).join('')}</details>` : '<p class="why">Offline mode does not judge reveal strategy or compare ending alternatives. Use a connected model for this decision.</p>'}
    <div class="detail-label">WHY THIS SEQUENCE</div><p class="why">${escape(r.why)}</p>${c.rejectionReason ? `<div class="failure-box">${escape(c.rejectionReason)}</div>` : ''}
    <div class="detail-label">EDIT DECISION LIST / IN PLAYBACK ORDER</div>${c.segments.map((s,i) => `<details class="segment"><summary><b>${i+1}. ${escape(s.episode)}</b> · ${time(s.start)} → ${time(s.end)} · ${s.duration.toFixed(2)}s</summary>${s.before ? `<div class="source-row"><time>BEFORE CUT · ${time(s.before.start)}</time>${escape(s.before.text)}</div>` : ''}${s.records.map(r => `<div class="source-row"><time>${time(r.start)} → ${time(r.end)} · ${escape(r.id)}${r.start < s.start || r.end > s.end ? ' · crosses cut boundary' : ''}</time>${escape(r.text)}</div>`).join('')}${s.after ? `<div class="source-row"><time>AFTER CUT · ${time(s.after.start)}</time>${escape(s.after.text)}</div>` : ''}</details>`).join('')}
    <div class="detail-label">RANKING BREAKDOWN</div><div class="score-grid">${[['hook','Hook · 35%'],['cliffhanger','Cliffhanger · 30%'],['clarity','Clarity · 25%'],['emotion','Emotion · 10%']].map(([k,title]) => `<div class="metric"><span>${title}</span><strong>${r[k]}<small> / 5</small></strong></div>`).join('')}</div>
    ${r.risks.length ? `<div class="detail-label">WHAT COULD BE WRONG</div><ul class="risks">${r.risks.map(s => `<li>${escape(s)}</li>`).join('')}</ul>` : ''}
    <div class="detail-label">YOUR EDITORIAL CALL</div><div class="review-controls">${[['approved','Approve'],['rejected','Reject'],['needs-review','Needs review']].map(([value,text]) => `<button class="small-button ${f.decision === value ? 'chosen' : ''}" data-decision="${value}">${text}</button>`).join('')}</div><textarea class="review-note" rows="3" placeholder="What worked? What did the agent miss?" aria-label="Editorial review note">${escape(f.note ?? '')}</textarea><p class="why">Feedback is kept in this tab and included in Export run. It does not alter the original agent output.</p>`;
  $('#detail').querySelectorAll('[data-decision]').forEach(el => el.addEventListener('click', () => { feedback[c.id] = { ...feedback[c.id], decision:el.dataset.decision, at:new Date().toISOString() }; renderList(); renderDetail(); }));
  $('.review-note').addEventListener('input', e => { feedback[c.id] = { ...feedback[c.id], note:e.target.value }; });
}
function download(data, name) { const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{ type:'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
$('#files').addEventListener('change', e => importFiles(e.target.files));
$('#folder').addEventListener('change', e => importFiles(e.target.files));
$('#folder-button').addEventListener('click', () => $('#folder').click());
$('#episode-select').addEventListener('change',renderSource);
$('#sample-button').addEventListener('click', async () => { try { load(await (await fetch('/sample.json')).json(),'Synthetic sample · not Kuku content'); } catch(e) { notice(e.message); } });
$('#local-pack').addEventListener('click', async () => { try { const r = await fetch('/api/local-pack'); if (!r.ok) throw new Error('Local pack unavailable. Use Import folder.'); load(await r.json(),'Local screenplay pack'); } catch(e) { notice(e.message); } });
$('#paste-button').addEventListener('click', () => { try { const text = $('#paste-input').value.trim(); load(/^[\[{]/.test(text) && !/^\[\d\d:/.test(text) ? JSON.parse(text) : parseText(text),'Pasted records'); } catch(e) { notice(e.message); } });
$('#token').addEventListener('input',updateRun); $('#mode').addEventListener('change',updateRun); $('#run').addEventListener('click',run); $('#cancel').addEventListener('click',() => controller?.abort());
$('#export').addEventListener('click', () => download({ ...report, sourceLabel, editorialFeedback:feedback },`promo-lab-${report.runId}.json`));
$('#export-trace').addEventListener('click', () => download(events,`promo-lab-trace-${Date.now()}.json`));
document.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => { tab = el.dataset.tab; document.querySelectorAll('[data-tab]').forEach(t => { t.classList.toggle('selected', t === el); t.setAttribute('aria-selected',String(t === el)); }); renderList(); }));
$('#trace-toggle').addEventListener('click', () => { const expanded = $('#trace-body').hidden; $('#trace-body').hidden = !expanded; $('#trace-toggle').setAttribute('aria-expanded',String(expanded)); });
$('#help-button').addEventListener('click',() => $('#help').showModal()); $('#close-help').addEventListener('click',() => $('#help').close());
$('#dropzone').addEventListener('dragover',e => { e.preventDefault(); $('#dropzone').classList.add('drag'); });
$('#dropzone').addEventListener('dragleave',() => $('#dropzone').classList.remove('drag'));
$('#dropzone').addEventListener('drop',e => { e.preventDefault(); $('#dropzone').classList.remove('drag'); importFiles(e.dataTransfer.files); });
try { status = await (await fetch('/api/status')).json(); $('#local-pack').hidden = !status.localPack; $('#token-field').hidden = !status.tokenRequired; $('#environment').textContent = status.hosted ? 'Hosted workspace' : 'Local workspace'; updateRun(); } catch { notice('Backend unavailable. Start the app with npm run dev.'); }
