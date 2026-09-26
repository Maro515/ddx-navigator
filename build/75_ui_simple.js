/* ============================================================
 * Simple UI — フリー入力（音声可）中心の3画面: 入力 / 結果 / 設定
 *  診断ロジックは持たない。大きな文字・少ない操作。
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };
  const UI = { state: null, last: null, tab: 'input', busy: false, lastAdded: [], pending: null, listening: false, confirmKey: null, demoQueue: null, open: {} };
  DDX.UI = UI;

  /* ---------- helpers ---------- */
  function valueLabel(f, code) { if (!f.values) return ''; const v = f.values.find(x => x.code === code); return v ? v.label : code; }
  function timeText(o) { const f = KB().feature[o.feature_id]; if (f.anchor === 'none' || !o.time_context.elapsed_bucket) return ''; const b = o.time_context.elapsed_bucket; if (KB().time.tier1Of(b) === 'unknown') return ''; return KB().time.label(b) + '前'; }
  function obsLine(o) {
    const f = KB().feature[o.feature_id]; const st = KB().status.find(s => s.code === o.status);
    const v = o.status === 'present' ? (f.values ? valueLabel(f, o.value_code) : 'あり') : (st ? st.label : o.status);
    const sev = o.severity ? { mild: '軽', moderate: '中', severe: '高' }[o.severity] : '';
    const tr = o.time_context.trend && o.time_context.trend !== 'unknown' ? (KB().trend.find(t => t.code === o.time_context.trend) || {}).label : '';
    return { label: f.label.replace('（部位）', ''), value: v, meta: [o.note, sev && '程度' + sev, timeText(o), tr].filter(Boolean).join(' · '), absent: o.status === 'absent' };
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2000); }
  function saveCase() { LS.set('ddxnav_case', UI.state.toJSON()); }
  function dLabel(id) { return (KB().disease[id] || {}).label || id; }
  function fLabel(id) { return (KB().feature[id] || {}).label || id; }
  async function recompute(action) {
    if (UI.busy) return; UI.busy = true;
    try { UI.last = await DDX.run(UI.state, { action: action || 'update' }); } catch (e) { console.error(e); toast('計算エラー: ' + e.message); }
    UI.busy = false; saveCase(); renderAll();
  }
  UI.recompute = recompute;

  /* ---------- render ---------- */
  function renderAll() { renderTabs(); renderInput(); renderResult(); renderSettings(); }
  UI.renderAll = renderAll;
  function renderTabs() {
    const em = UI.last ? UI.last.next.emergency.frame.length : 0, al = UI.last ? UI.last.safety.alerts.filter(a => a.level === 'emergent').length : 0;
    document.querySelectorAll('nav.tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === UI.tab); const nn = b.querySelector('.n'); if (nn) nn.remove(); if (b.dataset.tab === 'result' && (em || al)) b.insertAdjacentHTML('beforeend', `<span class="n">${al ? '!' : em}</span>`); });
    document.querySelectorAll('section.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + UI.tab));
    const p = $('#pillLLM'); const L = DDX.Extract.LLM;
    p.textContent = L.ready() ? 'AI: ' + (L.models.find(m => m.id === L.config.model) || {}).label.split('（')[0] : 'AI: 未設定（ローカル解析）'; p.className = 'pill ' + (L.ready() ? 'on' : '');
  }
  function bannersHtml() {
    if (!UI.last) return ''; const s = UI.last.safety; let h = '';
    if (s.scope.status !== 'in_scope') h += `<div class="banner scope"><b>${s.scope.status === 'out_of_scope' ? '対象外' : '専用経路'}</b><div class="msg">${esc(s.scope.messages.join(' '))}</div></div>`;
    for (const a of s.alerts) h += `<div class="banner ${a.level}"><b>${a.level === 'emergent' ? '🚨 ' : a.level === 'path' ? '🔀 ' : '⚠️ '}${esc(a.label)}</b><div class="msg">${esc(a.message)}</div></div>`;
    for (const c of s.contradictions) h += `<div class="banner warning"><b>❗ 矛盾の可能性</b><div class="msg">${esc(c.message)}</div></div>`;
    return h;
  }
  function renderInput() {
    const st = UI.state, c = st.context, kb = KB();
    let h = '';
    h += `<div class="ctxrow"><select data-ctx="age_band" aria-label="年齢帯"><option value="">年齢帯</option>${kb.context.age_band.map(o => `<option value="${o.code}" ${o.code === c.age_band ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select><select data-ctx="sex" aria-label="性別"><option value="">性別</option>${kb.context.sex.map(o => `<option value="${o.code}" ${o.code === c.sex ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${c.sex !== 'male' ? `<select data-ctx="pregnancy" aria-label="妊娠可能性">${kb.context.pregnancy.map(o => `<option value="${o.code}" ${o.code === c.pregnancy ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}</div>`;
    h += `<div class="inputbox"><div class="tawrap"><textarea id="freeText" rows="5" placeholder="例）40代女性。昨日から右下腹部痛が悪化、嘔気あり。反跳痛あり。体温38.2、CRP 5.8。妊娠反応陰性。">${esc(UI.draft || '')}</textarea><button class="mic ${UI.listening ? 'rec' : ''}" data-act="mic" title="音声入力" aria-label="音声入力">${UI.listening ? '⏹' : '🎤'}</button></div>
      <div class="inputacts"><button class="big" data-act="body">🧍 部位</button><button class="big" data-act="labs">🧪 検査値</button><button class="big primary grow" data-act="analyze" ${UI.busy ? 'disabled' : ''}>${UI.busy ? '解析中…' : '情報を追加'}</button></div>
      <div class="tiny muted">送信前に氏名・ID・日付・連絡先などは自動で除去されます${DDX.Extract.LLM.ready() ? '' : '。AI 未設定のためローカル解析で動作中（設定で API キーを登録）'}</div></div>`;
    if (UI.pending) {
      const p = UI.pending;
      h += `<div class="card confirm"><h2>送信内容の確認</h2><div class="scrubbed">${esc(p.scrubbed.text)}</div>${p.scrubbed.removed.length ? `<div class="small muted">除去: ${p.scrubbed.removed.map(r => esc(r.kind)).join('、')}</div>` : '<div class="small muted">個人情報は検出されませんでした</div>'}<div class="inputacts"><button class="big primary grow" data-act="send">この内容で追加（AI）</button><button class="big" data-act="localOnly">送らずに解析</button><button class="big ghost" data-act="cancelSend">取消</button></div></div>`;
    }
    if (UI.lastAdded.length || (UI.lastResult && UI.lastResult.unmapped && UI.lastResult.unmapped.length)) {
      h += `<div class="card"><h2>読み取った項目 <span class="cnt">${UI.lastResult && UI.lastResult.llm && UI.lastResult.llm.ok ? 'AI' : 'ローカル解析'}${UI.lastResult && UI.lastResult.llm && UI.lastResult.llm.ok === false ? '（AI エラー→ローカル）' : ''}</span></h2><div class="items">`;
      for (const id of UI.lastAdded) { const o = st.observations.find(x => x.obs_id === id); if (!o) continue; const l = obsLine(o); h += `<div class="item ${l.absent ? 'abs' : ''}"><div class="grow"><b>${esc(l.label)}</b> ${esc(l.value)}<div class="tiny muted">${esc(l.meta)}</div></div><button class="ghost" data-del="${o.obs_id}" aria-label="削除">✕</button></div>`; }
      if (UI.lastResult && UI.lastResult.unmapped && UI.lastResult.unmapped.length) h += `<div class="tiny muted" style="margin-top:6px">対応項目なし（記録のみ）: ${UI.lastResult.unmapped.map(esc).join('、')}</div>`;
      if (UI.lastResult && UI.lastResult.llm && UI.lastResult.llm.ok === false) h += `<div class="tiny" style="color:var(--danger)">AI: ${esc(UI.lastResult.llm.error)}</div>`;
      h += `</div></div>`;
    }
    const cur = st.current();
    if (cur.length) {
      h += `<div class="card"><details ${UI.open.entered ? 'open' : ''} data-details="entered"><summary>入力済み ${cur.length} 件</summary><div class="items" style="margin-top:8px">${cur.map(o => { const l = obsLine(o); return `<div class="item ${l.absent ? 'abs' : ''} ${st.isStale(o) ? 'stale' : ''}"><div class="grow"><b>${esc(l.label)}</b> ${esc(l.value)}<div class="tiny muted">${esc(l.meta)}${st.isStale(o) ? ' · 古い' : ''}</div></div><button class="ghost" data-del="${o.obs_id}" aria-label="削除">✕</button></div>`; }).join('')}</div></details></div>`;
    } else if (!UI.lastAdded.length) {
      h += `<div class="card"><div class="empty">話すか書くだけで、鑑別と次の一手を出します。<br><br>まだ何も入力されていません。上の欄に主訴・経過・所見・検査値を自由に入れてください。</div></div>`;
    }
    if (UI.demoQueue && UI.demoQueue.steps.length) h += `<div class="banner path"><b>デモ: ${esc(UI.demoQueue.label)}</b><div class="msg">残り ${UI.demoQueue.steps.length} ステップ <button class="ghost" data-act="demoNext">次のメモを入れる ▶</button></div></div>`;
    $('#view-input').innerHTML = h;
  }
  function qTextFor(feature_id) {
    const f = KB().feature[feature_id];
    const base = f.label.replace('（部位）', '');
    if (f.type === 'lab' || f.type === 'imaging') return `${base} を確認`;
    if (f.type === 'vital') return `${base} を測定`;
    return `${base} は？`;
  }
  function quickAnswerHtml(feature_id) {
    const f = KB().feature[feature_id];
    if (!f.values) return `<div class="qa"><button data-qa="${feature_id}|present">あり</button><button data-qa="${feature_id}|absent">なし</button><button data-qa="${feature_id}|unknown">不明</button></div>`;
    if (f.values.length <= 6) return `<div class="qa">${f.values.map(v => `<button data-qa="${feature_id}|present|${v.code}">${esc(v.label)}</button>`).join('')}<button data-qa="${feature_id}|not_assessed">実施不可</button></div>`;
    return `<div class="qa"><button data-ins="${esc(base(f))} ">入力欄に書く</button><button data-qa="${feature_id}|not_assessed">実施不可</button></div>`;
    function base(f) { return f.label.replace(/（.*?）|\s*\(.*?\)/g, ''); }
  }
  function evidenceHtml(x) {
    const kb = KB(); const item = (s, cls) => { const f = kb.feature[s.feature_id]; const o = s.obs; const v = o ? (o.status === 'present' ? (f.values ? valueLabel(f, o.value_code) : 'あり') : 'なし') : ''; return `<span class="tag ${cls}">${esc(f.label.replace('（部位）', ''))}${v ? ': ' + esc(v) : ''}</span>`; };
    let h = '';
    if (x.support.length) h += `<div class="ev"><span class="lab">支持</span>${x.support.slice(0, 6).map(s => item(s, 'sup')).join('')}</div>`;
    if (x.refute.length) h += `<div class="ev"><span class="lab">反証</span>${x.refute.slice(0, 6).map(s => item(s, 'ref')).join('')}</div>`;
    const rels = kb.relByDisease[x.id] || []; const ids = [...new Set(rels.flatMap(r => r.ev || []))];
    if (ids.length) h += `<details class="tiny"><summary>根拠文献 ${ids.length}</summary>${ids.map(id => { const e = kb.evidenceById[id]; return e ? `<div><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> ${e.year}, N=${e.n}</div>` : ''; }).join('')}</details>`;
    return h;
  }
  function renderResult() {
    if (!UI.last) { $('#view-result').innerHTML = ''; return; }
    const d = UI.last.ddx, n = UI.last.next, em = n.emergency, s = UI.last.safety;
    let h = bannersHtml();
    if (!d.nObs) { h += `<div class="card"><div class="empty">まだ情報がありません。「入力」で主訴を入れてください。</div></div>`; $('#view-result').innerHTML = h; return; }
    if (s.scope.status === 'out_of_scope') { $('#view-result').innerHTML = h; return; }
    // 1. 先に確認（安全ルール）
    if (n.forced.length) h += `<div class="card urgent"><h2>🚨 先に確認</h2>${n.forced.map(it => `<div class="qitem"><div class="q">${esc(qTextFor(it.feature_id))}</div><div class="tiny muted">${esc(it.forcedReason || '安全ルール')}${it.clears && it.clears.length ? ' · 除外対象: ' + it.clears.map(c => esc(c.label)).join('、') : ''}</div>${quickAnswerHtml(it.feature_id)}</div>`).join('')}</div>`;
    // 2. まず除外（緊急）
    h += `<div class="card"><h2>🟥 まず除外 <span class="cnt">${em.frame.length ? '候補に挙がった重大疾患 ' + em.frame.length : '候補なし'}</span></h2>`;
    if (!em.frame.length) h += `<div class="empty small">現在の情報で候補に挙がった重大疾患はありません${em.cleared.length ? '（除外済み: ' + em.cleared.map(m => esc(m.label)).join('、') + '）' : ''}</div>`;
    for (const m of em.frame) {
      const key = 'E' + m.id;
      h += `<div class="dx"><div class="head" data-toggle="${key}"><span class="name">${esc(m.label)}</span><span class="badge ${m.status}">${m.status === 'alert' ? '要注意' : '未除外'}</span></div>`;
      if (m.shortest) h += `<div class="qitem"><div class="q">→ ${esc(qTextFor(m.shortest.feature_id))}${m.shortest.key ? ' <span class="tiny">（決定的）</span>' : ''}</div>${quickAnswerHtml(m.shortest.feature_id)}</div>`;
      else h += `<div class="tiny muted">除外項目はすべて入力済み/結果待ち</div>`;
      if (UI.open[key]) h += `<div class="detail"><div class="tiny muted">${esc(m.note || '')}</div><div class="ev"><span class="lab">除外項目</span>${m.plan.map(x => `<span class="tag ${x.done ? (x.positive ? 'ref' : 'sup') : ''}">${x.done ? (x.positive ? '⚠' : '✓') : '○'} ${esc(x.label)}${x.key ? '★' : ''}</span>`).join('')}</div></div>`;
      h += `</div>`;
    }
    if (em.cleared.length) h += `<div class="tiny muted" style="margin-top:6px">✓ 概ね除外: ${em.cleared.map(m => esc(m.label)).join('、')}</div>`;
    h += `</div>`;
    // 3. 可能性の高い順
    h += `<div class="card"><h2>🟦 可能性の高い順 ${d.insufficient ? '<span class="cnt">情報不足・暫定</span>' : ''}</h2>`;
    for (const x of d.likely.filter(x => !x.comorbid).slice(0, 5)) { const key = 'L' + x.id; h += `<div class="dx"><div class="head" data-toggle="${key}"><span class="rank">${x.rank}</span><span class="name">${esc(x.label)}</span><span class="badge ${x.fit}">${{ high: '高', mid: '中', low: '低' }[x.fit]}</span></div>${UI.open[key] ? `<div class="detail">${evidenceHtml(x)}</div>` : ''}</div>`; }
    const more = d.likely.filter(x => !x.comorbid).slice(5);
    if (more.length) h += `<details class="small" style="margin-top:6px"><summary>6位以下 (${more.length})</summary>${more.map(x => `<div class="dx"><div class="head" data-toggle="L${x.id}"><span class="rank">${x.rank}</span><span class="name">${esc(x.label)}</span><span class="badge ${x.fit}">${{ high: '高', mid: '中', low: '低' }[x.fit]}</span></div>${UI.open['L' + x.id] ? `<div class="detail">${evidenceHtml(x)}</div>` : ''}</div>`).join('')}</details>`;
    const como = d.likely.filter(x => x.comorbid); if (como.length) h += `<div class="tiny muted" style="margin-top:6px">併存の可能性: ${como.map(x => esc(x.label)).join('、')}</div>`;
    h += `</div>`;
    // 4. 次に聞く・調べる
    h += `<div class="card"><h2>❓ 次に聞く・調べる</h2>`;
    if (!n.differential.top.length) h += `<div class="empty small">候補がありません</div>`;
    for (const it of n.differential.top) h += `<div class="qitem"><div class="q">${esc(qTextFor(it.feature_id))}${it.inEmergency ? ' <span class="badge alert">除外にも有効</span>' : ''}</div><div class="tiny muted">${esc((it.reasons || [])[0] || '')}</div>${quickAnswerHtml(it.feature_id)}</div>`;
    h += `</div>`;
    h += `<div class="disc">研究用プロトタイプ。順位は未較正の適合度で、確率ではありません。最終判断は医師が行ってください。</div>`;
    $('#view-result').innerHTML = h;
  }
  function renderSettings() {
    const L = DDX.Extract.LLM, v = DDX.Audit.versions(), cov = KB().evidenceCoverage || {};
    let h = `<div class="card"><h2>AI 解析（Claude API）</h2>
      <label class="lab">API キー（この端末にのみ保存）</label><input type="password" id="apiKey" value="${esc(L.config.apiKey)}" placeholder="sk-ant-...">
      <label class="lab">モデル</label><select id="model">${L.models.map(m => `<option value="${m.id}" ${m.id === L.config.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="confirmSend" ${L.config.confirm ? 'checked' : ''}> 送信前に除去後の文面を確認する</label>
      <div class="inputacts"><button class="big primary" data-act="saveLLM">保存</button></div>
      <div class="tiny muted">送信するのは除去後の本文と項目カタログだけです。API キーはブラウザから直接 Anthropic に送られ、他のサーバーを経由しません。</div></div>`;
    h += `<div class="card"><h2>症例</h2><div class="inputacts"><button class="big ${UI.confirmKey === 'newCase' ? 'danger' : ''}" data-act="newCase">${UI.confirmKey === 'newCase' ? 'もう一度押して新規開始' : '新規症例'}</button><button class="big" data-act="exportCase">症例JSON書き出し</button></div>
      <label class="lab" style="margin-top:10px">デモ症例（メモを順に入力）</label><select id="demoSel">${DDX.DEMO_TEXT.map((d, i) => `<option value="${i}">${esc(d.label)}</option>`).join('')}</select><div class="inputacts"><button class="big" data-act="demoStart">読み込む</button></div></div>`;
    h += `<div class="card"><h2>記録・根拠</h2><div class="small">監査ログ ${DDX.Audit.list().length} 件 · 根拠文献 ${KB().evidence.length} 件（感度+特異度を文献値で ${cov.with_values || 0} / 感度のみ ${cov.partial || 0} / 全 ${cov.total || 0} 関係）</div>
      <div class="inputacts"><button class="big" data-act="exportLog">ログ書き出し</button><button class="big danger" data-act="clearLog">${UI.confirmKey === 'clearLog' ? 'もう一度押して消去' : 'ログ消去'}</button></div>
      <details class="small" style="margin-top:8px"><summary>根拠文献一覧</summary>${KB().evidence.map(e => `<div class="log"><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> — ${esc(e.journal)} ${e.year}, ${esc(e.population)}, N=${e.n}</div>`).join('')}</details>
      <details class="small" style="margin-top:6px"><summary>参照ガイドライン (${KB().guidelines.length}) / 本文確認待ち (${(KB().pendingEvidence || []).length})</summary>${KB().guidelines.map(x => `<div class="log">📘 <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></div>`).join('')}${(KB().pendingEvidence || []).map(x => `<div class="log">⏳ <a href="https://pubmed.ncbi.nlm.nih.gov/${esc(x.pmid)}/" target="_blank" rel="noopener">${esc(x.title)}</a> — ${esc(x.status || '')}</div>`).join('')}</details></div>`;
    h += `<div class="card"><h2>版</h2>${Object.entries(v).map(([k, x]) => `<div class="kv"><span>${k}</span><span>${esc(x)}</span></div>`).join('')}<div class="disc">研究用プロトタイプ（Phase 1）。医療機器承認なし。Medical DB は専門家レビュー前のドラフトを含みます。</div></div>`;
    $('#view-settings').innerHTML = h;
  }

  /* ---------- body picker (複数選択 → 確定で入力欄に挿入。前面/背面 → 大部位 → 細部) ---------- */
  function openBody() { UI.body = { view: UI.bodyView || 'front', fineKey: null, sel: [] }; $('#sheetWrap').classList.add('open'); renderBody(); }
  function closeBody() { $('#sheetWrap').classList.remove('open'); $('#sheetWrap').classList.remove('full'); UI.body = null; }
  function imgTag(mirror) { const bm = DDX.BODYMAP; return `<image href="${bm.img.src}" x="0" y="0" width="${bm.img.w}" height="${bm.img.h}" ${mirror ? `transform="translate(${bm.img.w},0) scale(-1,1)"` : ''}/>`; }
  const clean = t => t.replace(/（.*?）/g, '');
  function bodyToggle(id) { const b = UI.body; const i = b.sel.indexOf(id); if (i >= 0) b.sel.splice(i, 1); else b.sel.push(id); }
  function selLabels() { return UI.body.sel.map(id => { const r = DDX.BODYMAP.find(id); return r ? clean(r.label) : id; }); }
  function coarseSvg(viewKey, isSel) {
    const bm = DDX.BODYMAP, view = bm.views[viewKey];
    return `<div class="bodycol"><div class="bodycap">${esc(view.label)}<span class="tiny muted">（${esc(view.note)}）</span></div><svg class="body coarse" viewBox="${bm.viewBox}" xmlns="http://www.w3.org/2000/svg">${imgTag(view.mirror)}${view.coarse.map(r => { const anySub = bm.fine[r.sub].regions.some(x => isSel(x.id)); return `<polygon points="${r.poly}" class="rg ${isSel(r.id) ? 'sel' : anySub ? 'has' : ''}" data-bregion="${r.id}"><title>${esc(r.label)}</title></polygon>${r.lbl ? `<text x="${r.lbl[0]}" y="${r.lbl[1]}" class="rl" data-bregion="${r.id}">${esc(clean(r.label))}</text>` : ''}`; }).join('')}</svg></div>`;
  }
  function renderBody() {
    const bm = DDX.BODYMAP, b = UI.body, isSel = id => b.sel.includes(id);
    $('#sheetWrap').classList.add('full');
    $('#sheetHd').innerHTML = `<div class="row"><b class="grow" style="font-size:19px">部位を選ぶ</b><button class="ghost" data-act="closeBody">閉じる</button></div>
      <div class="selbar"><div class="grow small">${b.sel.length ? '選択中: <b>' + selLabels().map(esc).join('・') + '</b>' : '<span class="muted">部位をタップして選択（複数可）</span>'}</div><button class="big primary" data-act="bodyCommit" ${b.sel.length ? '' : 'disabled'}>確定 (${b.sel.length})</button></div>`;
    let body = '';
    if (b.fineKey) {
      const f = bm.fine[b.fineKey]; const mirror = bm.viewOfFine(b.fineKey) === 'back';
      const parent = Object.values(bm.views).flatMap(v => v.coarse).find(c => c.sub === b.fineKey);
      body += `<div class="row" style="margin-bottom:6px"><button class="big" data-act="bodyCoarse">‹ 全身図へ戻る</button><b class="grow" style="font-size:19px">${esc(f.label)}</b>${parent ? `<button class="big ${isSel(parent.id) ? 'primary' : ''}" data-btoggle="${parent.id}">${isSel(parent.id) ? '✓ ' : ''}「${esc(clean(parent.label))}」全体</button>` : ''}</div>`;
      body += `<div class="bodywrap"><svg class="body fine" viewBox="${f.viewBox}" xmlns="http://www.w3.org/2000/svg">${imgTag(mirror)}${f.regions.map(r => `<polygon points="${r.poly}" class="rg ${isSel(r.id) ? 'sel' : ''}" data-btoggle="${r.id}"><title>${esc(r.label)}</title></polygon>${r.lbl ? `<text x="${r.lbl[0]}" y="${r.lbl[1]}" class="rl fine" data-btoggle="${r.id}">${esc(r.short || r.label)}</text>` : ''}`).join('')}</svg></div>`;
      body += `<div class="chips" style="margin-top:10px;justify-content:center">${f.regions.map(r => `<span class="chip ${isSel(r.id) ? 'sel' : ''}" data-btoggle="${r.id}">${isSel(r.id) ? '✓ ' : ''}${esc(r.label)}</span>`).join('')}</div>`;
    } else {
      body += `<div class="bodypair">${coarseSvg('front', isSel)}${coarseSvg('back', isSel)}</div><div class="tiny muted" style="text-align:center;margin-top:6px">大まかな部位をタップ → 細部を複数選択 → 確定</div>`;
    }
    $('#sheetBody').innerHTML = body;
  }
  function bodyCommit() { const labels = selLabels(); closeBody(); if (labels.length) insertText(labels.join('・') + 'に'); }
  /* ---------- 検査値パネル（一覧 → 電卓） ---------- */
  function openLabs() { UI.labs = { sel: null, buf: '' }; UI.labValues = UI.labValues || {}; $('#sheetWrap').classList.add('open'); renderLabs(); }
  function closeLabs() { $('#sheetWrap').classList.remove('open'); $('#sheetWrap').classList.remove('full'); UI.labs = null; }
  function renderLabs() {
    const Lb = DDX.LABS, st = UI.labs;
    $('#sheetHd').innerHTML = `<div class="row"><b class="grow">検査値（タップして数値を入力）</b><button class="ghost" data-act="closeLabs">閉じる</button></div>`;
    let h = '';
    if (st.sel) {
      const it = Lb.byId[st.sel];
      h += `<div class="row" style="margin-bottom:6px"><button class="ghost" data-act="labBack">‹ 一覧</button><b class="grow">${esc(it.label)} <span class="muted small">${esc(it.unit)}</span></b></div>`;
      if (it.choice) { h += `<div class="qa" style="flex-direction:column;align-items:stretch">${it.choice.map(([code, label]) => `<button class="big" data-labchoice="${code}">${esc(label)}</button>`).join('')}</div>`; $('#sheetBody').innerHTML = h; return; }
      h += `<div class="calc"><div class="disp">${esc(st.buf || '')}<span class="unit">${esc(it.unit)}</span></div>${it.hint ? `<div class="tiny muted">${esc(it.hint)}</div>` : ''}<div class="keys">${['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'].map(k => `<button data-key="${k}">${k}</button>`).join('')}</div><div class="inputacts"><button class="big" data-act="labClear">クリア</button><button class="big primary grow" data-act="labCommit" ${st.buf ? '' : 'disabled'}>確定</button></div></div>`;
    } else {
      for (const gr of Lb.groups) {
        h += `<div class="fsec"><div class="lab">${esc(gr.label)}</div><div class="labgrid">${gr.items.map(it => { const v = UI.labValues[it.id]; return `<button class="labbtn ${v !== undefined ? 'done' : ''}" data-lab="${it.id}"><span class="ln">${esc(it.label)}</span><span class="lv">${v !== undefined ? esc(String(v)) + (it.unit ? ' ' + esc(it.unit) : '') : (it.unit || 'タップして選択')}</span></button>`; }).join('')}</div></div>`;
      }
      h += `<div class="tiny muted" style="margin-top:8px">数値は本アプリの閾値で区分して登録します。対応項目のない検査は入力欄にテキストとして残します。単位・基準値: <a href="${esc(Lb.source.url)}" target="_blank" rel="noopener">${esc(Lb.source.label)}</a></div>`;
    }
    $('#sheetBody').innerHTML = h;
  }
  function labCommit() {
    const st = UI.labs, it = DDX.LABS.byId[st.sel]; let v = parseFloat(st.buf); if (!(v >= 0)) { toast('数値を入力してください'); return; }
    if (it.norm) v = it.norm(v);
    UI.labValues[it.id] = v;
    if (it.map) { const m = it.map(v, UI.state.context); UI.state.add({ feature_id: m.f, status: 'present', value_code: m.code, time_context: { elapsed_bucket: 'h_1_3', trend: 'unknown' }, note: `${it.label} ${v} ${it.unit}` }); toast(`${it.label} ${v} ${it.unit} → ${valueLabel(KB().feature[m.f], m.code)}`); recompute('lab_value'); }
    else { insertText(`${it.label} ${v} ${it.unit}。`); toast(`${it.label} ${v} ${it.unit} を入力欄に追加`); }
    st.sel = null; st.buf = ''; renderLabs();
  }
  function insertText(t) { const ta = $('#freeText'); if (!ta) { UI.draft = (UI.draft || '') + t; return; } const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? ta.value.length; ta.value = ta.value.slice(0, s) + t + ta.value.slice(e); UI.draft = ta.value; ta.focus(); const pos = s + t.length; ta.setSelectionRange(pos, pos); }

  /* ---------- 音声入力 ---------- */
  let rec = null;
  function toggleMic() {
    const SR = g.SpeechRecognition || g.webkitSpeechRecognition;
    if (!SR) { toast('この環境では音声入力を使えません（Chrome/Safari の通常ブラウザで開いてください）'); return; }
    if (UI.listening) { try { rec.stop(); } catch (e) { } return; }
    rec = new SR(); rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
    let finalText = '';
    rec.onresult = ev => { let interim = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finalText += r[0].transcript + '。'; else interim += r[0].transcript; } const ta = $('#freeText'); if (ta) { ta.value = (UI.draftBase || '') + finalText + interim; UI.draft = ta.value; } };
    rec.onend = () => { UI.listening = false; UI.draft = ($('#freeText') || {}).value || UI.draft; renderInput(); };
    rec.onerror = e => { toast('音声入力エラー: ' + (e.error || '')); UI.listening = false; renderInput(); };
    UI.draftBase = (($('#freeText') || {}).value || '') + (UI.draft && !/[。\n]$/.test(UI.draft) && UI.draft ? '' : '');
    if (UI.draftBase && !/[。\n\s]$/.test(UI.draftBase)) UI.draftBase += '。';
    UI.listening = true; renderInput(); try { rec.start(); } catch (e) { UI.listening = false; renderInput(); toast('音声入力を開始できません'); }
  }

  /* ---------- 解析 → 追加 ---------- */
  async function analyze() {
    const text = (($('#freeText') || {}).value || UI.draft || '').trim();
    if (!text) { toast('テキストを入力してください'); return; }
    UI.draft = text;
    const L = DDX.Extract.LLM;
    if (L.ready() && L.config.confirm) { UI.pending = { text, scrubbed: DDX.Extract.scrub(text) }; renderInput(); return; }
    await runExtract(text, L.ready());
  }
  async function runExtract(text, useLLM) {
    UI.pending = null; UI.busy = true; renderInput();
    let res;
    try { res = await DDX.Extract.extract(text, { useLLM }); } catch (e) { res = { items: [], context: {}, unmapped: [], llm: { ok: false, error: String(e) } }; }
    UI.busy = false;
    UI.lastResult = res; UI.lastAdded = [];
    for (const k in res.context) if (res.context[k] && !UI.state.context[k] || (k === 'pregnancy' && UI.state.context.pregnancy === 'unknown')) UI.state.context[k] = res.context[k];
    if (UI.state.context.sex === 'male') UI.state.context.pregnancy = 'no';
    for (const it of res.items) { try { const o = UI.state.add(it); UI.lastAdded.push(o.obs_id); } catch (e) { console.warn(e); } }
    UI.draft = ''; const ta = $('#freeText'); if (ta) ta.value = '';
    DDX.Audit.log({ action: 'extract', case_token: UI.state.case_token, provider: res.provider, llm: res.llm, n_items: res.items.length, removed: (res.scrubbed && res.scrubbed.removed || []).map(r => r.kind) });
    toast(res.items.length ? `${res.items.length} 項目を追加しました` : '該当する項目が見つかりませんでした');
    await recompute('extract');
    if (res.items.length) { UI.tab = 'result'; renderTabs(); }
  }
  function quickAnswer(spec) {
    const [fid, status, value] = spec.split('|');
    const f = KB().feature[fid];
    UI.state.add({ feature_id: fid, status, value_code: value || null, time_context: { elapsed_bucket: f.anchor === 'none' ? null : (f.type === 'vital' || f.type === 'exam' ? 'min_lt10' : f.type === 'lab' || f.type === 'imaging' ? 'h_1_3' : 'unknown'), trend: 'unknown' } });
    toast(`${f.label.replace('（部位）', '')}: ${status === 'present' ? (value ? valueLabel(f, value) : 'あり') : status === 'absent' ? 'なし' : status === 'unknown' ? '不明' : '実施不可'}`);
    recompute('quick_answer');
  }

  /* ---------- demo ---------- */
  function demoStart(i) { const d = DDX.DEMO_TEXT[i]; if (!d) return; UI.state = new DDX.ClinicalState({}); UI.demoQueue = { label: d.label, steps: d.steps.slice() }; UI.lastAdded = []; UI.lastResult = null; UI.tab = 'input'; demoNext(); }
  function demoNext() { if (!UI.demoQueue || !UI.demoQueue.steps.length) return; const t = UI.demoQueue.steps.shift(); if (!UI.demoQueue.steps.length) UI.demoQueue = null; UI.draft = t; UI.tab = 'input'; renderAll(); }

  /* ---------- events ---------- */
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  function bind() {
    document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => { UI.tab = b.dataset.tab; renderTabs(); }));
    $('#sheetWrap .bg').addEventListener('click', () => { if (UI.labs) closeLabs(); else closeBody(); });
    document.addEventListener('input', e => { if (e.target.id === 'freeText') UI.draft = e.target.value; });
    document.addEventListener('change', e => { const t = e.target; if (t.dataset.ctx) { UI.state.context[t.dataset.ctx] = t.value || null; if (t.dataset.ctx === 'sex' && t.value === 'male') UI.state.context.pregnancy = 'no'; recompute('context'); } });
    document.addEventListener('toggle', e => { const d = e.target.dataset && e.target.dataset.details; if (d) UI.open[d] = e.target.open; }, true);
    document.addEventListener('click', async e => {
      const el = e.target.closest('[data-act],[data-toggle],[data-del],[data-qa],[data-ins],[data-bregion],[data-bview],[data-btoggle],[data-lab],[data-key],[data-labchoice]'); if (!el) return; const d = el.dataset;
      if (d.toggle) { UI.open[d.toggle] = !UI.open[d.toggle]; renderResult(); return; }
      if (d.del) { UI.state.remove(d.del); UI.lastAdded = UI.lastAdded.filter(x => x !== d.del); recompute('delete'); return; }
      if (d.qa) { quickAnswer(d.qa); return; }
      if (d.ins) { UI.tab = 'input'; renderTabs(); insertText(d.ins); return; }
      if (d.lab) { UI.labs.sel = d.lab; UI.labs.buf = ''; renderLabs(); return; }
      if (d.labchoice) { const it = DDX.LABS.byId[UI.labs.sel]; const lab = (it.choice.find(c => c[0] === d.labchoice) || [])[1]; UI.labValues[it.id] = lab; UI.state.add({ feature_id: it.f, status: 'present', value_code: d.labchoice, time_context: { elapsed_bucket: 'h_1_3', trend: 'unknown' } }); toast(`${it.label}: ${lab}`); recompute('lab_value'); UI.labs.sel = null; renderLabs(); return; }
      if (d.key) { if (d.key === '⌫') UI.labs.buf = UI.labs.buf.slice(0, -1); else if (d.key === '.') { if (!UI.labs.buf.includes('.')) UI.labs.buf += UI.labs.buf ? '.' : '0.'; } else if (UI.labs.buf.length < 8) UI.labs.buf += d.key; renderLabs(); return; }
      if (d.bview) { UI.body.view = d.bview; UI.bodyView = d.bview; UI.body.fineKey = null; renderBody(); return; }
      if (d.btoggle) { bodyToggle(d.btoggle); renderBody(); return; }
      if (d.bregion) { const r = DDX.BODYMAP.find(d.bregion); if (r && r.sub) { UI.body.fineKey = r.sub; renderBody(); } else { bodyToggle(d.bregion); renderBody(); } return; }
      switch (d.act) {
        case 'mic': toggleMic(); break;
        case 'body': openBody(); break;
        case 'closeBody': closeBody(); break;
        case 'labs': openLabs(); break;
        case 'closeLabs': closeLabs(); break;
        case 'labBack': UI.labs.sel = null; UI.labs.buf = ''; renderLabs(); break;
        case 'labClear': UI.labs.buf = ''; renderLabs(); break;
        case 'labCommit': labCommit(); break;
        case 'bodyCoarse': UI.body.fineKey = null; renderBody(); break;
        case 'bodyCommit': bodyCommit(); break;
        case 'analyze': await analyze(); break;
        case 'send': await runExtract(UI.pending.text, true); break;
        case 'localOnly': await runExtract(UI.pending.text, false); break;
        case 'cancelSend': UI.pending = null; renderInput(); break;
        case 'saveLLM': { const L = DDX.Extract.LLM; L.config.apiKey = $('#apiKey').value.trim(); L.config.model = $('#model').value; L.config.confirm = $('#confirmSend').checked; LS.set('ddxnav_llm', { apiKey: L.config.apiKey, model: L.config.model, confirm: L.config.confirm }); toast('保存しました'); renderAll(); break; }
        case 'newCase': if (UI.confirmKey === 'newCase') { UI.confirmKey = null; UI.state = new DDX.ClinicalState({}); UI.lastAdded = []; UI.lastResult = null; UI.demoQueue = null; UI.open = {}; UI.draft = ''; recompute('new_case'); UI.tab = 'input'; } else { UI.confirmKey = 'newCase'; renderSettings(); setTimeout(() => { if (UI.confirmKey === 'newCase') { UI.confirmKey = null; renderSettings(); } }, 4000); } break;
        case 'exportCase': download(`ddx_case_${UI.state.case_token}.json`, JSON.stringify(UI.state.toJSON(), null, 2)); break;
        case 'exportLog': download('ddx_audit_log.json', DDX.Audit.export()); break;
        case 'clearLog': if (UI.confirmKey === 'clearLog') { UI.confirmKey = null; DDX.Audit.clear(); renderSettings(); } else { UI.confirmKey = 'clearLog'; renderSettings(); setTimeout(() => { if (UI.confirmKey === 'clearLog') { UI.confirmKey = null; renderSettings(); } }, 4000); } break;
        case 'demoStart': demoStart(+$('#demoSel').value); break;
        case 'demoNext': demoNext(); break;
      }
    });
  }
  UI.init = function () {
    const saved = LS.get('ddxnav_case', null);
    UI.state = saved ? DDX.ClinicalState.fromJSON(saved) : new DDX.ClinicalState({});
    const lc = LS.get('ddxnav_llm', null); if (lc) Object.assign(DDX.Extract.LLM.config, lc);
    bind(); recompute('boot');
  };
})(typeof window !== 'undefined' ? window : globalThis);
