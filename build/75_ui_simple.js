/* ============================================================
 * Simple UI — ホーム（患者一覧・フォルダ）と、フリー入力（音声可）中心の 入力 / 結果 / 設定
 *  診断ロジックは持たない。大きな文字・少ない操作。
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } } };
  const UI = { state: null, last: null, tab: 'home', busy: false, lastAdded: [], pending: null, listening: false, confirmKey: null, demoQueue: null, open: {}, labValues: {}, draft: '',
    homeFolder: 'all', homeQuery: '', ptMenu: null, newPt: false, folderEdit: null };
  const P = () => DDX.Patients;
  DDX.UI = UI;

  /* ---------- helpers ---------- */
  function valueLabel(f, code) { if (!f.values) return ''; const v = f.values.find(x => x.code === code); return v ? v.label : code; }
  function timeText(o) { const f = KB().feature[o.feature_id]; if (f.anchor === 'none' || !o.time_context.elapsed_bucket) return ''; const b = o.time_context.elapsed_bucket; if (KB().time.tier1Of(b) === 'unknown') return ''; return KB().time.label(b) + '前'; }
  function obsLine(o) {
    const f = KB().feature[o.feature_id]; const st = KB().status.find(s => s.code === o.status);
    const v = o.status === 'present' ? (f.values ? valueLabel(f, o.value_code) : 'あり') : (o.status === 'absent' && o.value_code && f.values ? valueLabel(f, o.value_code) + ' なし' : (st ? st.label : o.status));
    const sev = o.severity ? { mild: '軽', moderate: '中', severe: '高' }[o.severity] : '';
    const tr = o.time_context.trend && o.time_context.trend !== 'unknown' ? (KB().trend.find(t => t.code === o.time_context.trend) || {}).label : '';
    return { label: f.label.replace('（部位）', ''), value: v, meta: [o.note, sev && '程度' + sev, timeText(o), tr].filter(Boolean).join(' · '), absent: o.status === 'absent' };
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2000); }
  // 表示中の患者のデータ（症例 state・検査値・下書き）と一覧用の要約を保存する
  function saveCase() {
    const Pt = P(), id = Pt.index.currentId; if (!id || !UI.state) return Promise.resolve(false);
    const r = UI.last, d = r && r.ddx;
    const summary = d ? { top: d.likely.filter(x => !x.comorbid).slice(0, 3).map(x => x.id), n: d.nObs, alert: r.safety.alerts.filter(a => a.level === 'emergent').length, mnm: r.next.emergency.frame.length } : undefined;
    return Pt.saveData(id, { state: UI.state.toJSON(), labValues: UI.labValues || {}, draft: UI.draft || '' }, { hash: UI.state.hash(), summary }).catch(() => false);
  }
  // 確認が要る操作（削除など）は 2 回押しで実行。4 秒で取り消し
  function armConfirm(key, rerender) { UI.confirmKey = key; rerender(); setTimeout(() => { if (UI.confirmKey === key) { UI.confirmKey = null; rerender(); } }, 4000); }
  function dLabel(id) { return (KB().disease[id] || {}).label || id; }
  function fLabel(id) { return (KB().feature[id] || {}).label || id; }
  async function recompute(action) {
    if (UI.busy) return; UI.busy = true;
    try { UI.last = await DDX.run(UI.state, { action: action || 'update' }); } catch (e) { console.error(e); toast('計算エラー: ' + e.message); }
    UI.busy = false; saveCase(); renderAll();
  }
  UI.recompute = recompute;

  /* ---------- render ---------- */
  function renderAll() { renderTabs(); renderHome(); renderInput(); renderResult(); renderSettings(); }
  UI.renderAll = renderAll;
  function renderTabs() {
    const em = UI.last ? UI.last.next.emergency.frame.length : 0, al = UI.last ? UI.last.safety.alerts.filter(a => a.level === 'emergent').length : 0;
    document.querySelectorAll('nav.tabs button').forEach(b => { b.classList.toggle('on', b.dataset.tab === UI.tab); const nn = b.querySelector('.n'); if (nn) nn.remove(); if (b.dataset.tab === 'result' && (em || al)) b.insertAdjacentHTML('beforeend', `<span class="n">${al ? '!' : em}</span>`); });
    document.querySelectorAll('section.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + UI.tab));
    const p = $('#pillLLM'); const L = DDX.Extract.LLM;
    p.textContent = L.ready() ? 'AI: ' + L.label() : 'ローカル解析'; p.title = L.ready() ? 'AI 解析: ' + L.label() : 'AI 未設定（ローカル解析で動作中）'; p.className = 'pill ' + (L.ready() ? 'on' : '');
    const cp = P().current(), pp = $('#pillPt'); pp.textContent = cp ? '👤 ' + cp.name : '患者未選択'; pp.classList.toggle('none', !cp); pp.title = cp ? cp.name : '';
  }
  function bannersHtml() {
    if (!UI.last) return ''; const s = UI.last.safety; let h = '';
    if (s.scope.status !== 'in_scope') h += `<div class="banner scope"><b>${s.scope.status === 'out_of_scope' ? '対象外' : '専用経路'}</b><div class="msg">${esc(s.scope.messages.join(' '))}</div></div>`;
    for (const a of s.alerts) h += `<div class="banner ${a.level}"><b>${a.level === 'emergent' ? '🚨 ' : a.level === 'path' ? '🔀 ' : '⚠️ '}${esc(a.label)}</b><div class="msg">${esc(a.message)}</div></div>`;
    for (const c of s.contradictions) h += `<div class="banner warning"><b>❗ 矛盾の可能性</b><div class="msg">${esc(c.message)}</div></div>`;
    return h;
  }
  function noPatientHtml() {
    return `<div class="card"><div class="empty">患者が選ばれていません。<br>ホームで患者を選ぶか、新規登録してください。</div><div class="inputacts"><button class="big primary grow" data-act="quickPt" ${P().full() ? 'disabled' : ''}>＋ 新規患者（呼び名はあとで変更可）</button><button class="big" data-act="goHome">ホームへ</button></div></div>`;
  }
  function renderInput() {
    if (!P().current()) { $('#view-input').innerHTML = noPatientHtml(); return; }
    const st = UI.state, c = st.context, kb = KB();
    let h = '';
    h += `<div class="ctxrow"><select data-ctx="age_band" aria-label="年齢帯"><option value="">年齢帯</option>${kb.context.age_band.map(o => `<option value="${o.code}" ${o.code === c.age_band ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select><select data-ctx="sex" aria-label="性別"><option value="">性別</option>${kb.context.sex.map(o => `<option value="${o.code}" ${o.code === c.sex ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${c.sex !== 'male' ? `<select data-ctx="pregnancy" aria-label="妊娠可能性">${kb.context.pregnancy.map(o => `<option value="${o.code}" ${o.code === c.pregnancy ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}${c.sex !== 'male' && c.pregnancy !== 'no' ? `<select data-ctx="preg_stage" aria-label="妊娠時期"><option value="">妊娠時期</option>${kb.context.preg_stage.map(o => `<option value="${o.code}" ${o.code === c.preg_stage ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>` : ''}</div>`;
    h += `<div class="inputbox"><div class="tawrap"><textarea id="freeText" rows="5" placeholder="例）40代女性。昨日から右下腹部痛が悪化、嘔気あり。反跳痛あり。体温38.2、CRP 5.8。妊娠反応陰性。">${esc(UI.draft || '')}</textarea><button class="mic ${UI.listening ? 'rec' : ''}" data-act="mic" title="音声入力" aria-label="音声入力">${UI.listening ? '⏹' : '🎤'}</button></div>
      <div class="inputacts"><button class="big" data-act="body">🧍 部位</button><button class="big" data-act="labs">🧪 検査値</button><button class="big primary grow" data-act="analyze" ${UI.busy ? 'disabled' : ''}>${UI.busy ? '解析中…' : '情報を追加'}</button></div>
      <div class="tiny muted">送信前に氏名・ID・日付・連絡先などは自動で除去されます${DDX.Extract.LLM.ready() ? '' : '。AI 未設定のためローカル解析で動作中（設定で API キーを登録）'}</div></div>`;
    if (UI.pending) {
      const p = UI.pending;
      const L = DDX.Extract.LLM;
      h += `<div class="card confirm"><h2>送信内容の確認</h2><div class="small muted">送信先: ${esc(L.vendorName[L.vendor()])}（${esc(L.label())}）</div><div class="scrubbed">${esc(p.scrubbed.text)}</div>${p.scrubbed.removed.length ? `<div class="small muted">除去: ${p.scrubbed.removed.map(r => esc(r.kind)).join('、')}</div>` : '<div class="small muted">個人情報は検出されませんでした</div>'}<div class="inputacts"><button class="big primary grow" data-act="send">この内容で追加（AI）</button><button class="big" data-act="localOnly">送らずに解析</button><button class="big ghost" data-act="cancelSend">取消</button></div></div>`;
    }
    if (UI.lastAdded.length || (UI.lastResult && UI.lastResult.unmapped && UI.lastResult.unmapped.length)) {
      h += `<div class="card"><h2>読み取った項目 <span class="cnt">${UI.lastResult && UI.lastResult.llm && UI.lastResult.llm.ok ? 'AI（' + esc(DDX.Extract.LLM.label(UI.lastResult.llm.model)) + '）' : 'ローカル解析'}${UI.lastResult && UI.lastResult.llm && UI.lastResult.llm.ok === false ? '（AI エラー→ローカル）' : ''}</span></h2><div class="items">`;
      for (const id of UI.lastAdded) { const o = st.observations.find(x => x.obs_id === id); if (!o) continue; const l = obsLine(o); h += `<div class="item ${l.absent ? 'abs' : ''}"><div class="grow"><b>${esc(l.label)}</b> ${esc(l.value)}<div class="tiny muted">${esc(l.meta)}</div></div><button class="ghost" data-del="${o.obs_id}" aria-label="削除">✕</button></div>`; }
      if (UI.lastResult && UI.lastResult.unmapped && UI.lastResult.unmapped.length) h += `<div class="tiny muted" style="margin-top:6px">対応項目なし（記録のみ）: ${UI.lastResult.unmapped.map(esc).join('、')}</div>`;
      if (UI.lastResult && UI.lastResult.llm && UI.lastResult.llm.ok === false) h += `<div class="tiny" style="color:var(--danger)">AI: ${esc(UI.lastResult.llm.error)}</div>`;
      h += `</div></div>`;
    }
    const cur = st.current().filter(o => !(o.derived && o.status === 'absent'));
    if (cur.length) {
      h += `<div class="card"><details ${UI.open.entered ? 'open' : ''} data-details="entered"><summary>入力済み ${cur.length} 件</summary><div class="items" style="margin-top:8px">${cur.map(o => { const l = obsLine(o); return `<div class="item ${l.absent ? 'abs' : ''} ${st.isStale(o) ? 'stale' : ''}"><div class="grow"><b>${esc(l.label)}</b> ${esc(l.value)}<div class="tiny muted">${o.derived ? esc(o.note || '自動') + '（自動）' : esc(l.meta)}${st.isStale(o) ? ' · 古い' : ''}</div></div>${o.derived ? '' : `<button class="ghost" data-del="${o.obs_id}" aria-label="削除">✕</button>`}</div>`; }).join('')}</div></details></div>`;
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
    // 問診系(症状/主訴/既往)は「不明」、検査系(バイタル/診察/検査/画像)は「実施不可」で未取得扱いにする
    const askType = f.type === 'symptom' || f.type === 'chief_complaint' || f.type === 'history' || f.type === 'context';
    const naBtn = askType ? `<button data-qa="${feature_id}|unknown">不明</button>` : `<button data-qa="${feature_id}|not_assessed">実施不可</button>`;
    if (!f.values) return `<div class="qa"><button data-qa="${feature_id}|present">あり</button><button data-qa="${feature_id}|absent">なし</button>${naBtn}</div>`;
    // 選択肢に「なし/正常/陰性」が無い項目(黒色便・血便, 嘔吐の性状 等)は、否定回答 = absent ボタンを補う
    const hasNeg = f.values.some(v => /^(normal|none|neg|absent|no)$/.test(v.code) || /^(なし|正常|陰性|異常なし)$/.test(v.label));
    const noNeg = f.id === 'pain_onset_char'; // 発症様式など「なし」が意味を持たない項目
    const negBtn = (hasNeg || noNeg || !(askType || f.type === 'exam')) ? '' : `<button data-qa="${feature_id}|absent">なし</button>`;
    if (f.values.length <= 6) return `<div class="qa">${f.values.map(v => `<button data-qa="${feature_id}|present|${v.code}">${esc(v.label)}</button>`).join('')}${negBtn}${naBtn}</div>`;
    return `<div class="qa"><button data-ins="${esc(base(f))} ">入力欄に書く</button>${negBtn}${naBtn}</div>`;
    function base(f) { return f.label.replace(/（.*?）|\s*\(.*?\)/g, ''); }
  }
  function prevTag(id) { const t = KB().prevalenceTier && KB().prevalenceTier(id); return t ? `<span class="prev">${esc(t)}</span>` : ''; }
  function evidenceHtml(x) {
    const kb = KB(); const item = (s, cls) => { const f = kb.feature[s.feature_id]; const o = s.obs; const v = o ? (o.status === 'present' ? (f.values ? valueLabel(f, o.value_code) : 'あり') : (o.value_code && f.values ? valueLabel(f, o.value_code) + ' なし' : 'なし')) : ''; return `<span class="tag ${cls}">${esc(f.label.replace('（部位）', ''))}${v ? ': ' + esc(v) : ''}</span>`; };
    let h = '';
    if (x.support.length) h += `<div class="ev"><span class="lab">支持</span>${x.support.slice(0, 6).map(s => item(s, 'sup')).join('')}</div>`;
    if (x.refute.length) h += `<div class="ev"><span class="lab">反証</span>${x.refute.slice(0, 6).map(s => item(s, 'ref')).join('')}</div>`;
    const rels = kb.relByDisease[x.id] || []; const ids = [...new Set(rels.flatMap(r => r.ev || []))];
    if (ids.length) h += `<details class="tiny"><summary>根拠文献 ${ids.length}</summary>${ids.map(id => { const e = kb.evidenceById[id]; return e ? `<div><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a> ${e.year}, N=${e.n}</div>` : ''; }).join('')}</details>`;
    return h;
  }
  function renderResult() {
    if (!P().current()) { $('#view-result').innerHTML = noPatientHtml(); return; }
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
    if (em.more && em.more.length) h += `<details class="small" style="margin-top:6px"><summary>ほかに候補となり得る重大疾患 (${em.more.length})</summary><div class="tiny muted" style="margin-top:4px">${em.more.map(m => esc(m.label)).join('、')}</div></details>`;
    if (em.cleared.length) h += `<div class="tiny muted" style="margin-top:6px">✓ 概ね除外: ${em.cleared.map(m => esc(m.label)).join('、')}</div>`;
    h += `</div>`;
    // 3. 可能性の高い順
    h += `<div class="card"><h2>🟦 可能性の高い順 ${d.insufficient ? '<span class="cnt">情報不足・暫定</span>' : ''}</h2><div class="tiny muted" style="margin:-4px 0 6px">所見で区別できない疾患は頻度の高い順</div>`;
    for (const x of d.likely.filter(x => !x.comorbid).slice(0, 5)) { const key = 'L' + x.id; h += `<div class="dx"><div class="head" data-toggle="${key}"><span class="rank">${x.rank}</span><span class="name">${esc(x.label)}</span>${prevTag(x.id)}<span class="badge ${x.fit}">${{ high: '高', mid: '中', low: '低' }[x.fit]}</span></div>${UI.open[key] ? `<div class="detail">${evidenceHtml(x)}</div>` : ''}</div>`; }
    const more = d.likely.filter(x => !x.comorbid).slice(5);
    if (more.length) h += `<details class="small" style="margin-top:6px"><summary>6位以下 (${more.length})</summary>${more.map(x => `<div class="dx"><div class="head" data-toggle="L${x.id}"><span class="rank">${x.rank}</span><span class="name">${esc(x.label)}</span>${prevTag(x.id)}<span class="badge ${x.fit}">${{ high: '高', mid: '中', low: '低' }[x.fit]}</span></div>${UI.open['L' + x.id] ? `<div class="detail">${evidenceHtml(x)}</div>` : ''}</div>`).join('')}</details>`;
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
    let h = `<div class="card"><h2>AI 解析</h2>
      <label class="lab">モデル</label><select id="model">${L.models.map(m => `<option value="${m.id}" ${m.id === L.config.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      <label class="lab">Anthropic API キー（Claude を使う場合・この端末にのみ保存）</label><input type="password" id="apiKey" value="${esc(L.config.apiKey)}" placeholder="sk-ant-..." autocomplete="off">
      <label class="lab">OpenAI API キー（GPT-6 Luna を使う場合・この端末にのみ保存）</label><input type="password" id="openaiKey" value="${esc(L.config.openaiKey || '')}" placeholder="sk-..." autocomplete="off">
      <label class="chk"><input type="checkbox" id="confirmSend" ${L.config.confirm ? 'checked' : ''}> 送信前に除去後の文面を確認する</label>
      <div class="inputacts"><button class="big primary" data-act="saveLLM">保存</button></div>
      <div class="tiny muted">送信するのは除去後の本文と項目カタログだけです。API キーと本文はブラウザから直接、選んだモデルの提供元（Anthropic または OpenAI）に送られ、他のサーバーを経由しません。OpenAI には応答を保存しない指定（store: false）で送ります。選んだモデルのキーが無いときはローカル解析で動きます。</div></div>`;
    const cp = P().current();
    h += `<div class="card"><h2>表示中の患者 <span class="cnt">${cp ? esc(cp.name) : 'なし'}</span></h2>${cp ? `<div class="inputacts"><button class="big ${UI.confirmKey === 'newCase' ? 'danger' : ''}" data-act="newCase">${UI.confirmKey === 'newCase' ? 'もう一度押して入力を消去' : 'この患者の入力をリセット'}</button><button class="big" data-act="exportCase">症例JSON書き出し</button></div><div class="tiny muted">症例JSONには呼び名を含めません。</div>` : '<div class="tiny muted">ホームで患者を選ぶと、入力のリセットや書き出しができます。</div>'}
      <label class="lab" style="margin-top:10px">デモ症例（新しい患者として登録し、メモを順に入力）</label><select id="demoSel">${DDX.DEMO_TEXT.map((d, i) => `<option value="${i}">${esc(d.label)}</option>`).join('')}</select><div class="inputacts"><button class="big" data-act="demoStart" ${P().full() ? 'disabled' : ''}>読み込む</button></div></div>`;
    h += `<div class="card"><h2>患者データの控え <span class="cnt">${P().count()} / ${P().MAX} 人</span></h2><div class="inputacts"><button class="big" data-act="exportAll" ${P().count() ? '' : 'disabled'}>全患者を書き出し</button><button class="big" data-act="importAll">控えから取り込み</button><input type="file" id="importFile" accept="application/json,.json" hidden></div>
      <div class="tiny muted">書き出したファイルには患者の呼び名が含まれます。取り扱いに注意してください。取り込みは今の患者を残したまま追加します（同じ患者と上限 ${P().MAX} 人を超える分は取り込みません）。</div></div>`;
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
    if (it.map) {
      const mine = DDX.LABS.resolve(UI.labValues, UI.state.context).filter(x => x.from.includes(it.id));
      for (const x of mine) UI.state.add({ feature_id: x.f, status: x.status, value_code: x.code, time_context: { elapsed_bucket: 'h_1_3', trend: 'unknown' }, note: `${x.from.map(id => DDX.LABS.byId[id].label + ' ' + UI.labValues[id]).join(' / ')} ${x.from.length === 1 ? it.unit : ''}`.trim() });
      const pos = mine.filter(x => x.status === 'present').map(x => { const f = KB().feature[x.f]; return f.multi || x.f === 'ast_alt_pattern' ? valueLabel(f, x.code) : `${f.label.replace(/（.*?）/g, '')} ${valueLabel(f, x.code)}`; });
      toast(`${it.label} ${v} ${it.unit} → ${pos.length ? pos.join('、') : '異常なし'}`); recompute('lab_value');
    }
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

  /* ---------- ホーム（患者一覧・フォルダ） ---------- */
  function fmtTime(t) { const d = new Date(t), pad = n => String(n).padStart(2, '0'); return (d.toDateString() === new Date().toDateString() ? '今日 ' : `${d.getMonth() + 1}/${d.getDate()} `) + `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function ctxLabel(c) { const kb = KB(), lab = (list, code) => code ? (list.find(o => o.code === code) || {}).label || '' : ''; return [lab(kb.context.age_band, c && c.age_band), lab(kb.context.sex, c && c.sex)].filter(Boolean).join('・'); }
  function folderOptions(sel) { return `<option value="" ${sel ? '' : 'selected'}>未分類</option>` + P().index.folders.map(f => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)}</option>`).join(''); }
  function ptRowHtml(p) {
    const Pt = P(), cur = p.id === Pt.index.currentId, s = p.summary, f = Pt.folder(p.folderId);
    const dx = s && s.n && s.top && s.top.length ? `1位 ${esc(dLabel(s.top[0]))}` : '未入力';
    const flag = s && s.alert ? ` <span class="badge emergent">🚨 ${s.alert}</span>` : s && s.n && s.mnm ? ` <span class="badge open">除外待ち ${s.mnm}</span>` : '';
    const sub = [ctxLabel(p.context), f ? '📁 ' + f.name : '', s && s.n ? '入力 ' + s.n + ' 件' : '', '更新 ' + fmtTime(p.updated)].filter(Boolean).join(' · ');
    let h = `<div class="pt ${cur ? 'cur' : ''}" data-hopen="${p.id}"><div class="grow"><div class="pn">${esc(p.name)}${cur ? ' <span class="badge high">表示中</span>' : ''}</div><div class="sub">${esc(sub)}</div><div class="dx1">${dx}${flag}</div></div><button class="ghost" data-hmenu="${p.id}" aria-label="${esc(p.name)} の操作" aria-expanded="${UI.ptMenu === p.id}">⋯</button></div>`;
    if (UI.ptMenu === p.id) h += `<div class="ptmenu"><label class="lab">呼び名</label><div class="row"><input type="text" id="ptRename" class="grow" value="${esc(p.name)}" maxlength="${Pt.NAME_MAX}" style="width:auto"><button data-act="ptRename" data-id="${p.id}">変更</button></div>
      <label class="lab">フォルダ</label><select data-ptmove="${p.id}">${folderOptions(p.folderId)}</select>
      <div class="row"><button class="danger" data-act="ptDelete" data-id="${p.id}">${UI.confirmKey === 'del:' + p.id ? 'もう一度押して削除（元に戻せません）' : 'この患者を削除'}</button></div></div>`;
    return h;
  }
  function ptListHtml() {
    const list = P().list(UI.homeFolder, UI.homeQuery);
    if (!list.length) return `<div class="empty">${P().count() ? '該当する患者はいません' : 'まだ患者が登録されていません。<br>「＋ 新規患者」から登録してください。'}</div>`;
    return list.map(ptRowHtml).join('');
  }
  function newPtHtml() {
    const kb = KB();
    return `<div class="newpt" style="margin-top:10px"><label class="lab">呼び名（ベッド番号・イニシャルなど。この端末にだけ保存し、AI には送りません）</label><input type="text" id="npName" placeholder="例: 救急3番" maxlength="${P().NAME_MAX}">
      <div class="grid2"><div><label class="lab">年齢帯</label><select id="npAge"><option value="">未入力</option>${kb.context.age_band.map(o => `<option value="${o.code}">${esc(o.label)}</option>`).join('')}</select></div><div><label class="lab">性別</label><select id="npSex"><option value="">未入力</option>${kb.context.sex.map(o => `<option value="${o.code}">${esc(o.label)}</option>`).join('')}</select></div></div>
      <label class="lab">フォルダ</label><select id="npFolder">${folderOptions(P().folder(UI.homeFolder) ? UI.homeFolder : '')}</select>
      <div class="inputacts"><button class="big primary grow" data-act="createPt">登録して入力へ</button><button class="big ghost" data-act="cancelNewPt">取消</button></div></div>`;
  }
  function renderHome() {
    const Pt = P(); if (!Pt.backend) { $('#view-home').innerHTML = ''; return; }
    const n = Pt.count(), full = Pt.full(), fsel = UI.homeFolder, f = Pt.folder(fsel);
    let h = `<div class="card"><div class="homehd"><h2 style="margin:0">患者</h2><span class="cnt muted small">${n} / ${Pt.MAX} 人</span><div class="grow"></div><button class="big primary" data-act="newPt" ${full || UI.newPt ? 'disabled' : ''}>＋ 新規患者</button></div>`;
    if (full) h += `<div class="tiny" style="color:var(--danger);margin-top:6px">上限の ${Pt.MAX} 人に達しています。不要な患者を削除してから登録してください。</div>`;
    if (UI.newPt && !full) h += newPtHtml();
    const chip = (id, label, cnt) => `<button class="chip ${fsel === id ? 'sel' : ''}" data-hfolder="${id}">${esc(label)}<span class="n">${cnt}</span></button>`;
    h += `<div class="fchips" role="tablist" aria-label="フォルダ">${chip('all', 'すべて', n)}${chip('none', '未分類', Pt.folderCount('none'))}${Pt.index.folders.map(x => chip(x.id, '📁 ' + x.name, Pt.folderCount(x.id))).join('')}<button class="chip" data-act="newFolder">＋ フォルダ</button></div>`;
    if (UI.folderEdit === 'new') h += `<div class="fbar"><input type="text" id="folderName" class="grow" placeholder="フォルダ名（例: 救急外来、病棟5A）" maxlength="${Pt.FOLDER_MAX}" style="width:auto"><button class="primary" data-act="folderCreate">作成</button><button class="ghost" data-act="folderCancel">取消</button></div>`;
    else if (f && UI.folderEdit === f.id) h += `<div class="fbar"><input type="text" id="folderName" class="grow" value="${esc(f.name)}" maxlength="${Pt.FOLDER_MAX}" style="width:auto"><button class="primary" data-act="folderRename" data-id="${f.id}">変更</button><button class="ghost" data-act="folderCancel">取消</button></div>`;
    else if (f) h += `<div class="fbar muted"><span>📁 ${esc(f.name)}</span><button class="ghost" data-act="folderEdit" data-id="${f.id}">名前変更</button><button class="ghost" data-act="folderDelete" data-id="${f.id}" style="color:var(--danger)">${UI.confirmKey === 'fdel:' + f.id ? 'もう一度押して削除（患者は未分類へ）' : 'フォルダを削除'}</button></div>`;
    if (n > 5) h += `<input type="text" id="ptSearch" placeholder="呼び名で検索" value="${esc(UI.homeQuery)}" style="margin-bottom:8px" aria-label="呼び名で検索">`;
    h += `<div class="ptlist" id="ptList">${ptListHtml()}</div>`;
    const where = { indexeddb: 'この端末のブラウザ内（IndexedDB）', localStorage: 'この端末のブラウザ内（localStorage）', memory: 'メモリ上だけ（このブラウザでは保存できないため、再読み込みで消えます）' }[Pt.backend.kind];
    h += `<div class="tiny muted" style="margin-top:10px">患者データは${where}に保存します。呼び名は AI にも監査ログにも送りません。ブラウザのデータ消去などで消えることがあるため、設定の「全患者を書き出し」で控えを取ってください。</div></div>`;
    $('#view-home').innerHTML = h;
  }

  /* ---------- 患者の切り替え・登録・削除 ---------- */
  async function openPatient(id, tab) {
    const Pt = P(), meta = Pt.get(id); if (!meta) return;
    if (UI.busy) { toast('解析中は患者を切り替えられません'); return; }
    if (id !== Pt.index.currentId) await saveCase();
    const data = (await Pt.loadData(id)) || {};
    UI.state = data.state ? DDX.ClinicalState.fromJSON(data.state) : new DDX.ClinicalState({ context: Object.assign({}, meta.context, meta.context.sex === 'male' ? { pregnancy: 'no' } : {}) });
    UI.labValues = data.labValues || {}; UI.draft = data.draft || '';
    UI.lastAdded = []; UI.lastResult = null; UI.pending = null; UI.demoQueue = null; UI.open = {}; UI.confirmKey = null; UI.ptMenu = null; UI.newPt = false;
    Pt.setCurrent(id);
    UI.tab = tab || (UI.state.observations.length ? 'result' : 'input');
    await recompute('open_patient');
  }
  async function createPatient(o) {
    const Pt = P();
    if (UI.busy) { toast('解析中は登録できません'); return; }
    if (Pt.full()) { toast(`登録できるのは ${Pt.MAX} 人までです`); return; }
    const p = Pt.create(o);
    const st = new DDX.ClinicalState({ context: Object.assign({}, p.context, p.context.sex === 'male' ? { pregnancy: 'no' } : {}) });
    await Pt.saveData(p.id, { state: st.toJSON(), labValues: {}, draft: '' }, { hash: st.hash() }).catch(() => false);
    // 保存を消されにくくする（許可はブラウザが判断。拒否されても動作は同じ）
    try { if (Pt.count() === 1 && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { }); } catch (e) { }
    toast(`「${p.name}」を登録しました`);
    await openPatient(p.id, 'input');
    return p;
  }
  async function deletePatient(id) {
    const Pt = P(); if (UI.busy) { toast('解析中は削除できません'); return; }
    const wasCurrent = id === Pt.index.currentId, name = (Pt.get(id) || {}).name;
    await Pt.remove(id).catch(() => false);
    if (wasCurrent) { UI.state = new DDX.ClinicalState({}); UI.labValues = {}; UI.draft = ''; UI.lastAdded = []; UI.lastResult = null; UI.pending = null; UI.demoQueue = null; UI.open = {}; UI.last = null; }
    UI.ptMenu = null; UI.confirmKey = null;
    toast(`「${name}」を削除しました`); renderAll();
  }

  /* ---------- 解析 → 追加 ---------- */
  async function analyze() {
    const text = (($('#freeText') || {}).value || UI.draft || '').trim();
    if (!text) { toast('テキストを入力してください'); return; }
    if (!P().current()) { toast('先に患者を選んでください'); return; }
    UI.draft = text;
    const L = DDX.Extract.LLM;
    if (L.ready() && L.config.confirm) { UI.pending = { text, scrubbed: DDX.Extract.scrub(text) }; renderInput(); return; }
    await runExtract(text, L.ready());
  }
  async function runExtract(text, useLLM) {
    const pid = P().index.currentId, st0 = UI.state;
    UI.pending = null; UI.busy = true; renderInput();
    let res;
    try { res = await DDX.Extract.extract(text, { useLLM }); } catch (e) { res = { items: [], context: {}, unmapped: [], llm: { ok: false, error: String(e) } }; }
    UI.busy = false;
    // 解析中の切り替えは止めているが、万一患者が変わっていたら別の患者に書き込まない
    if (P().index.currentId !== pid || UI.state !== st0) { toast('患者が切り替わったため、解析結果は追加しませんでした'); renderAll(); return; }
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
  async function demoStart(i) { const d = DDX.DEMO_TEXT[i]; if (!d) return; const p = await createPatient({ name: 'デモ: ' + d.label }); if (!p) return; UI.demoQueue = { label: d.label, steps: d.steps.slice() }; UI.tab = 'input'; demoNext(); }
  function demoNext() { if (!UI.demoQueue || !UI.demoQueue.steps.length) return; const t = UI.demoQueue.steps.shift(); if (!UI.demoQueue.steps.length) UI.demoQueue = null; UI.draft = t; UI.tab = 'input'; renderAll(); }

  /* ---------- events ---------- */
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  function bind() {
    document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => { UI.tab = b.dataset.tab; renderTabs(); }));
    $('#sheetWrap .bg').addEventListener('click', () => { if (UI.labs) closeLabs(); else closeBody(); });
    document.addEventListener('input', e => {
      if (e.target.id === 'freeText') UI.draft = e.target.value;
      if (e.target.id === 'ptSearch') { UI.homeQuery = e.target.value; $('#ptList').innerHTML = ptListHtml(); }
    });
    document.addEventListener('keydown', e => { if (e.key !== 'Enter' || e.isComposing) return; const m = { npName: 'createPt', folderName: UI.folderEdit === 'new' ? 'folderCreate' : 'folderRename', ptRename: 'ptRename' }[e.target.id]; if (m) { e.preventDefault(); const b = document.querySelector(`[data-act="${m}"]`); if (b) b.click(); } });
    document.addEventListener('change', async e => {
      const t = e.target;
      if (t.dataset.ptmove) { P().move(t.dataset.ptmove, t.value || null); toast('フォルダを移しました'); renderHome(); return; }
      if (t.id === 'importFile' && t.files && t.files[0]) { try { const r = await P().importAll(JSON.parse(await t.files[0].text())); toast(`取り込み ${r.added} 人` + (r.dup ? `・既存 ${r.dup} 人は除外` : '') + (r.over ? `・上限超過 ${r.over} 人は除外` : '')); } catch (err) { toast('取り込めませんでした: ' + (err && err.message || err)); } t.value = ''; renderAll(); return; }
      if (t.dataset.ctx) { UI.state.context[t.dataset.ctx] = t.value || null; if (t.dataset.ctx === 'sex' && t.value === 'male') { UI.state.context.pregnancy = 'no'; UI.state.context.preg_stage = null; } if (t.dataset.ctx === 'pregnancy' && t.value === 'no') UI.state.context.preg_stage = null; if (t.dataset.ctx === 'preg_stage' && (t.value === 'first_tri' || t.value === 'late')) UI.state.context.pregnancy = 'confirmed'; recompute('context'); } });
    document.addEventListener('toggle', e => { const d = e.target.dataset && e.target.dataset.details; if (d) UI.open[d] = e.target.open; }, true);
    document.addEventListener('click', async e => {
      const el = e.target.closest('[data-act],[data-toggle],[data-del],[data-qa],[data-ins],[data-bregion],[data-bview],[data-btoggle],[data-lab],[data-key],[data-labchoice],[data-hopen],[data-hmenu],[data-hfolder]'); if (!el || el.disabled) return; const d = el.dataset;
      if (d.hmenu) { UI.ptMenu = UI.ptMenu === d.hmenu ? null : d.hmenu; UI.confirmKey = null; renderHome(); return; }
      if (d.hopen) { await openPatient(d.hopen); return; }
      if (d.hfolder) { UI.homeFolder = d.hfolder; UI.folderEdit = null; UI.confirmKey = null; renderHome(); return; }
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
        case 'saveLLM': { const L = DDX.Extract.LLM; L.config.apiKey = $('#apiKey').value.trim(); L.config.openaiKey = $('#openaiKey').value.trim(); L.config.model = $('#model').value; L.config.confirm = $('#confirmSend').checked; LS.set('ddxnav_llm', { apiKey: L.config.apiKey, openaiKey: L.config.openaiKey, model: L.config.model, confirm: L.config.confirm }); toast(L.ready() ? '保存しました' : `保存しました（${L.vendorName[L.vendor()]} のキーが未入力のためローカル解析）`); renderAll(); break; }
        // 表示中の患者の入力だけを消す（呼び名・フォルダ・年齢帯・性別は残す）
        case 'newCase': if (!P().current() || UI.busy) break; if (UI.confirmKey === 'newCase') { UI.confirmKey = null; const c = UI.state.context; UI.state = new DDX.ClinicalState({ context: { age_band: c.age_band, sex: c.sex, pregnancy: c.sex === 'male' ? 'no' : 'unknown' } }); UI.labValues = {}; UI.lastAdded = []; UI.lastResult = null; UI.demoQueue = null; UI.open = {}; UI.draft = ''; UI.pending = null; recompute('reset_patient'); UI.tab = 'input'; } else armConfirm('newCase', renderSettings); break;
        case 'goHome': UI.tab = 'home'; renderAll(); break;
        case 'newPt': UI.newPt = true; renderHome(); { const i = $('#npName'); if (i) i.focus(); } break;
        case 'cancelNewPt': UI.newPt = false; renderHome(); break;
        case 'createPt': await createPatient({ name: $('#npName').value, folderId: $('#npFolder').value || null, context: { age_band: $('#npAge').value || null, sex: $('#npSex').value || null } }); break;
        case 'quickPt': await createPatient({}); break;
        case 'newFolder': UI.folderEdit = 'new'; renderHome(); { const i = $('#folderName'); if (i) i.focus(); } break;
        case 'folderCancel': UI.folderEdit = null; renderHome(); break;
        case 'folderCreate': { const f = P().addFolder($('#folderName').value); if (!f) { toast('フォルダ名を入力してください'); break; } UI.folderEdit = null; UI.homeFolder = f.id; renderHome(); break; }
        case 'folderEdit': UI.folderEdit = d.id; renderHome(); { const i = $('#folderName'); if (i) i.focus(); } break;
        case 'folderRename': if (!P().renameFolder(d.id, $('#folderName').value)) { toast('フォルダ名を入力してください'); break; } UI.folderEdit = null; renderAll(); break;
        case 'folderDelete': if (UI.confirmKey === 'fdel:' + d.id) { UI.confirmKey = null; P().removeFolder(d.id); UI.homeFolder = 'all'; toast('フォルダを削除しました（患者は未分類へ）'); renderAll(); } else armConfirm('fdel:' + d.id, renderHome); break;
        case 'ptRename': if (!P().rename(d.id, $('#ptRename').value)) { toast('呼び名を入力してください'); break; } UI.ptMenu = null; renderAll(); break;
        case 'ptDelete': if (UI.confirmKey === 'del:' + d.id) await deletePatient(d.id); else armConfirm('del:' + d.id, renderHome); break;
        case 'exportAll': { const x = await P().exportAll(); const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''); download(`ddx_patients_${ts}.json`, JSON.stringify(x)); break; }
        case 'importAll': $('#importFile').click(); break;
        case 'exportCase': download(`ddx_case_${UI.state.case_token}.json`, JSON.stringify(UI.state.toJSON(), null, 2)); break;
        case 'exportLog': download('ddx_audit_log.json', DDX.Audit.export()); break;
        case 'clearLog': if (UI.confirmKey === 'clearLog') { UI.confirmKey = null; DDX.Audit.clear(); renderSettings(); } else { UI.confirmKey = 'clearLog'; renderSettings(); setTimeout(() => { if (UI.confirmKey === 'clearLog') { UI.confirmKey = null; renderSettings(); } }, 4000); } break;
        case 'demoStart': demoStart(+$('#demoSel').value); break;
        case 'demoNext': demoNext(); break;
      }
    });
  }
  UI.init = async function () {
    const lc = LS.get('ddxnav_llm', null); if (lc) Object.assign(DDX.Extract.LLM.config, lc);
    UI.state = new DDX.ClinicalState({});
    bind();
    const Pt = P(); Pt.onError = err => toast('保存できませんでした（容量不足の可能性）: ' + (err && err.message || err));
    await Pt.open();
    // 旧版（患者管理なし）で保存していた症例を最初の患者として引き継ぐ
    const old = LS.get('ddxnav_case', null);
    let migrated = !(old && old.observations && old.observations.length);
    if (!migrated) { try { const p = Pt.create({ name: '以前の症例' }); await Pt.saveData(p.id, { state: old, labValues: {}, draft: '' }, {}); Pt.setCurrent(p.id); migrated = true; } catch (e) { console.warn(e); } }
    if (migrated) { try { localStorage.removeItem('ddxnav_case'); } catch (e) { } }
    if (Pt.current()) await openPatient(Pt.index.currentId, 'home'); else { UI.tab = 'home'; await recompute('boot'); }
    // 画面を離れるときに下書きも保存する
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveCase(); });
  };
})(typeof window !== 'undefined' ? window : globalThis);
