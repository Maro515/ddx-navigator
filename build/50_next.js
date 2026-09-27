/* ============================================================
 * Next-Item Engine — 次に取るべき情報 Top5
 *  Priority = w1*EIG + w2*Mgmt + w3*MNM + w4*Urgency + w5*Jev − w6*Cost − w7*Invasive − w8*Delay − w9*Redundancy
 *  Safety override (forced) > Priority
 * Jev アダプタ — 差し替え可能。none / mock(模擬) / remote(HTTP)。算術・安全判定は渡さない。
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;
  const W = { eig: 3.0, mgmt: 1.0, mnm: 2.5, urg: 1.2, jev: 1.5, cost: 0.6, inv: 0.8, delay: 0.6, redund: 1.5, deferred: 2.0 };
  DDX.NEXT_WEIGHTS = W;

  function H(p) { let h = 0; for (const x of p) if (x > 0) h -= x * Math.log(x); return h; }
  function ageIdx(b) { const i = KB().ageIndex[b]; return i === undefined ? null : i; }
  function featureApplicable(f, ctx) {
    const femaleOnly = ['adnexal_tender', 'hcg', 'lmp_delayed', 'vaginal_bleeding', 'pregnancy_status', 'menstrual_relation', 'vaginal_discharge'];
    const maleOnly = ['scrotal_exam', 'scrotal_pain'];
    if (ctx.sex === 'male' && femaleOnly.includes(f.id)) return false;
    if (ctx.sex === 'female' && maleOnly.includes(f.id)) return false;
    if (f.id === 'hcg' && (ctx.pregnancy === 'no' || (ageIdx(ctx.age_band) !== null && ageIdx(ctx.age_band) >= ageIdx('50-59')))) return false;
    if (f.id === 'lmp_delayed' && ageIdx(ctx.age_band) !== null && ageIdx(ctx.age_band) >= ageIdx('50-59')) return false;
    return true;
  }
  const MGMT_TEXT = { 0: '', 1: '鑑別の絞り込み', 2: '検査・処置の選択が変わる', 3: '治療/紹介/入院の判断が直接変わる' };

  function compute(state, ddx, safety, opts) {
    opts = opts || {};
    const kb = KB();
    const jev = opts.jev || null; // {results:{fid:{relevance,confidence}}, ok}
    const ctx = state.context;
    // focus diseases: likely top10 + MNM open/alert
    const focus = {};
    for (const x of ddx.likely) if (!x.comorbid) focus[x.id] = Math.max(0.02, x.p);
    const mnmOpen = {};
    for (const m of ddx.mnm) if (m.status !== 'cleared') { mnmOpen[m.id] = m; focus[m.id] = Math.max(focus[m.id] || 0, 0.02); }
    // candidate features
    const cand = {};
    for (const did in focus) for (const r of kb.relByDisease[did] || []) {
      const f = kb.feature[r.f];
      if (!featureApplicable(f, ctx)) continue;
      if (state.isPending(r.f) || state.isNotAssessable(r.f) || state.isUnknown(r.f)) continue;
      const cur = state.get(r.f).filter(o => o.status === 'present' || o.status === 'absent');
      let remeasure = false;
      if (cur.length) { if (cur.every(o => state.isStale(o))) remeasure = true; else continue; }
      cand[r.f] = cand[r.f] || { f, rels: [], remeasure };
      cand[r.f].rels.push(r);
    }
    // exclusive posterior for EIG
    const excl = ddx.items.filter(x => !x.d.comorbid);
    const P = excl.map(x => x.p);
    const H0 = H(P);
    const observedGroups = new Set(state.current().filter(o => (o.status === 'present' || o.status === 'absent') && !state.isStale(o)).map(o => kb.feature[o.feature_id].group).filter(Boolean));
    const list = [];
    let maxEig = 1e-9;
    for (const fid in cand) {
      const c = cand[fid], f = c.f;
      // q_d = P(pos|d)
      const q = excl.map(x => { const rs = (kb.relByDisease[x.id] || []).filter(r => r.f === fid); if (!rs.length) return f.base; return Math.max(...rs.map(r => r.sens)); });
      const ppos = P.reduce((s, p, i) => s + p * q[i], 0);
      const pneg = 1 - ppos;
      const post1 = P.map((p, i) => ppos > 0 ? p * q[i] / ppos : 0), post0 = P.map((p, i) => pneg > 0 ? p * (1 - q[i]) / pneg : 0);
      const eig = Math.max(0, H0 - (ppos * H(post1) + pneg * H(post0)));
      maxEig = Math.max(maxEig, eig);
      // MNM value
      let mnmv = 0; const mnmFor = [];
      for (const r of c.rels) if (mnmOpen[r.d]) { const m = mnmOpen[r.d]; const v = (1 - m.clearedFrac) * (r.key ? 1 : 0.5) * Math.min(1, Math.abs(DDX.Differential.lnLRneg(r)) / 2); if (v > 0) { mnmv += v; if (!mnmFor.includes(r.d)) mnmFor.push(r.d); } }
      mnmv = Math.min(1.5, mnmv);
      // discrimination text
      const ups = [], downs = [];
      for (const r of c.rels) { if (!focus[r.d]) continue; const lp = DDX.Differential.lnLRpos(r), ln = DDX.Differential.lnLRneg(r);
        if (lp >= 0.7) { const u = ups.find(x => x.d === r.d); if (u) u.v = Math.max(u.v, lp); else ups.push({ d: r.d, v: lp }); }
        if (ln <= -0.7) { const u = downs.find(x => x.d === r.d); if (u) u.v = Math.min(u.v, ln); else downs.push({ d: r.d, v: ln }); } }
      ups.sort((a, b) => b.v - a.v); downs.sort((a, b) => a.v - b.v);
      const urg = (f.urgent ? 1 : 0) + (c.remeasure ? 0.5 : 0) + (safety && safety.emergent && f.type === 'vital' ? 1 : 0);
      const redund = (f.group && observedGroups.has(f.group)) ? 1 : 0;
      const jr = jev && jev.ok && jev.results && jev.results[fid];
      const jevv = (jr && jr.confidence >= 0.5) ? jr.relevance : 0;
      const a = f.acq;
      list.push({ feature_id: fid, label: f.label, type: f.type, typeLabel: kb.typeLabel[f.type], remeasure: c.remeasure, eigRaw: eig, mnmv, mnmFor, mgmt: f.mgmt, mgmtText: MGMT_TEXT[f.mgmt] || '',
        urg, redund, jev: jevv, jevConf: jr ? jr.confidence : null, cost: a.cost, inv: a.inv, delay: a.delay, stage: a.stage, ups: ups.slice(0, 3), downs: downs.slice(0, 3),
        deferred: !!state.deferred[fid] });
    }
    for (const it of list) {
      it.eig = it.eigRaw / maxEig;
      it.priority = W.eig * it.eig + W.mgmt * it.mgmt / 3 + W.mnm * it.mnmv + W.urg * it.urg + (jev && jev.ok ? W.jev * it.jev : 0)
        - W.cost * it.cost / 3 - W.inv * it.inv / 3 - W.delay * it.delay / 3 - W.redund * it.redund - (it.deferred ? W.deferred : 0);
      it.reasons = buildReasons(it, ddx);
    }
    list.sort((a, b) => b.priority - a.priority);
    // forced by safety
    const forced = [];
    for (const fid of (safety && safety.forced) || []) {
      const f = kb.feature[fid]; if (!f || !featureApplicable(f, ctx)) continue;
      const it = list.find(x => x.feature_id === fid) || { feature_id: fid, label: f.label, type: f.type, typeLabel: kb.typeLabel[f.type], mgmt: f.mgmt, mgmtText: MGMT_TEXT[f.mgmt], cost: f.acq.cost, inv: f.acq.inv, delay: f.acq.delay, ups: [], downs: [], mnmFor: [], reasons: [], priority: Infinity, eig: 0, mnmv: 0, urg: 1 };
      it.forced = true; it.forcedReason = (safety.forcedReason[fid] || []).join('、');
      forced.push(it);
    }
    const rest = list.filter(x => !x.forced);
    const top = rest.slice(0, 5), others = rest.slice(5, 15);
    const forcedIds = new Set(forced.map(x => x.feature_id));

    /* ---------- エマージェンシー枠: 候補に挙がった重大疾患を個別に除外 ---------- */
    // 枠に入る条件: 未除外 かつ（支持所見あり or 事後確率 ≥3% or 決定的陽性所見）
    const frameAll = [], outOfFrame = [], cleared = [];
    for (const m of ddx.mnm) {
      if (m.status === 'cleared') { cleared.push(m); continue; }
      // 候補に挙がる条件: 決定的陽性所見 / 事後確率≥3% / 強い支持所見(lnLR≥1.8) / 支持所見2つ以上でうち1つが中等度以上(lnLR≥1.0)
      const strong = m.support.filter(x => x.lnLR >= 1.0).length, vstrong = m.support.some(x => x.lnLR >= 1.8);
      const topP = ddx.likely.length ? ddx.likely[0].p : 1;
      const raised = m.positiveKey || vstrong || (m.support.length >= 2 && strong >= 1) || m.p >= Math.max(0.015, 0.1 * topP) || (m.rank > 0 && m.rank <= 8);
      (raised ? frameAll : outOfFrame).push(m);
    }
    frameAll.sort((a, b) => (b.openScore - a.openScore) || (b.p - a.p));
    const FRAME_MAX = 6;
    const frame = frameAll.slice(0, FRAME_MAX), frameMore = frameAll.slice(FRAME_MAX);
    const emDisease = {};
    for (const m of frame) {
      const plan = [];
      for (const fid of (kb.disease[m.id].clear || [])) {
        const f = kb.feature[fid]; if (!f || !featureApplicable(f, ctx)) continue;
        const rels = (kb.relByDisease[m.id] || []).filter(r => r.f === fid);
        const obs = state.get(fid).filter(o => o.status === 'present' || o.status === 'absent');
        const done = obs.length > 0 && !obs.every(o => state.isStale(o));
        const pos = done && rels.some(r => obs.some(o => o.status === 'present' && (!r.values || r.values.includes(o.value_code))));
        plan.push({ feature_id: fid, label: f.label, type: f.type, typeLabel: kb.typeLabel[f.type], key: rels.some(r => r.key), done, positive: pos, pending: state.isPending(fid), na: state.isNotAssessable(fid) || state.isUnknown(fid), cost: f.acq.cost, inv: f.acq.inv, delay: f.acq.delay });
      }
      // 最短除外: 未取得の決定的項目のうち負担最小
      const todo = plan.filter(x => !x.done && !x.pending && !x.na);
      const stageRank = t => ({ chief_complaint: 0, symptom: 0, history: 0, exam: 0, vital: 0, lab: 1, imaging: 2 })[t] ?? 1;
      todo.sort((a, b) => ((b.key - a.key)) || (stageRank(a.type) - stageRank(b.type)) || ((a.cost + a.inv + a.delay) - (b.cost + b.inv + b.delay)));
      emDisease[m.id] = { id: m.id, label: m.label, status: m.status, p: m.p, urgency: m.urgency, positiveKey: m.positiveKey, clearedFrac: m.clearedFrac, note: kb.disease[m.id].note, plan, shortest: todo[0] || null,
        supportLabels: m.support.slice(0, 3).map(x => kb.feature[x.feature_id].label) };
    }
    // 除外の推奨順: 複数の緊急疾患を同時に除外できる項目を負担込みで評価
    const exclScore = {};
    for (const m of frame) {
      const wD = (m.urgency === 'emergent' ? 1 : 0.7) * (0.5 + Math.min(1, m.p / 0.1)) * (m.status === 'alert' ? 1.3 : 1);
      for (const it of emDisease[m.id].plan) {
        if (it.done || it.pending || it.na) continue;
        const e = exclScore[it.feature_id] = exclScore[it.feature_id] || { feature_id: it.feature_id, label: it.label, type: it.type, typeLabel: it.typeLabel, cost: it.cost, inv: it.inv, delay: it.delay, value: 0, clears: [] };
        e.value += wD * (it.key ? 1 : 0.5) * (1 - m.clearedFrac);
        e.clears.push({ id: m.id, label: m.label, key: it.key });
      }
    }
    for (const fi of forced) { const e = exclScore[fi.feature_id]; if (e) fi.clears = e.clears; }
    const order = Object.values(exclScore).filter(e => !forcedIds.has(e.feature_id)).map(e => { const burden = 1 + (e.cost + e.inv + e.delay) / 3; e.efficiency = e.value / burden; e.deferred = !!state.deferred[e.feature_id]; if (e.deferred) e.efficiency *= 0.3; return e; })
      .sort((a, b) => b.efficiency - a.efficiency);
    const emergency = { frame: frame.map(m => emDisease[m.id]), more: frameMore.map(m => ({ id: m.id, label: m.label, status: m.status, p: m.p })), outOfFrame: outOfFrame.map(m => ({ id: m.id, label: m.label, status: m.status })), cleared: cleared.map(m => ({ id: m.id, label: m.label })), order: order.slice(0, 5), orderAll: order };

    /* ---------- 鑑別枠: 可能性順 Top10 の絞り込み（MNM 解除価値を除いた優先度） ---------- */
    const likelyIds = new Set(ddx.likely.filter(x => !x.comorbid).map(x => x.id));
    const dxList = rest.filter(it => (kb.relByFeature[it.feature_id] || []).some(r => likelyIds.has(r.d)))
      .map(it => Object.assign({}, it, { priorityDx: it.priority - W.mnm * it.mnmv, inEmergency: order.some(o => o.feature_id === it.feature_id) }))
      .sort((a, b) => b.priorityDx - a.priorityDx);
    const differential = { top: dxList.slice(0, 5), others: dxList.slice(5, 15) };

    return { forced, top, others, all: list, emergency, differential, jev: jev ? { enabled: true, ok: jev.ok, provider: jev.provider, latency: jev.latency, error: jev.error || null } : { enabled: false }, weights: W };
  }
  function buildReasons(it, ddx) {
    const lab = id => { const d = DDX.KB.disease[id] || {}; return d.short || d.label || id; };  // 疾患群は短い名前
    const r = [];
    const upIds = it.ups.map(x => x.d);
    const others = ddx.likely.filter(x => !x.comorbid && !upIds.includes(x.id)).slice(0, 2).map(x => lab(x.id));
    if (it.ups.length && others.length) r.push(`区別: ${it.ups.slice(0, 2).map(x => lab(x.d)).join('・')} vs ${others.join('・')}`);
    else if (it.ups.length) r.push(`陽性なら ${it.ups.slice(0, 2).map(x => lab(x.d)).join('・')} を支持`);
    else if (it.downs.length) r.push(`陰性なら ${it.downs.slice(0, 2).map(x => lab(x.d)).join('・')} を下げる`);
    if (it.mnmFor.length) r.push(`見逃し注意の解除: ${it.mnmFor.map(lab).join('・')}`);
    if (it.mgmtText) r.push(it.mgmtText);
    if (it.remeasure) r.push('前回の値が古いため再測定');
    if (it.redund) r.push('既取得情報と一部重複');
    if (it.deferred) r.push('「後で」に設定済み');
    return r;
  }

  /* ---------- Jev adapter ---------- */
  const Jev = {
    version: 'jev-adapter-0.1.0',
    config: { provider: 'none', endpoint: '', apiKey: '', timeoutMs: 4000 },
    buildPayload(state, ddx, candidates) {
      // 最小 state: 個人識別子・自由記載・具体日時は含めない
      const t1 = DDX.KB.time.tier1Of;
      return {
        case_token: state.case_token,
        care_context: { age_band: state.context.age_band, sex: state.context.sex, setting: state.context.setting },
        current_top_diseases: ddx.likely.filter(x => !x.comorbid).slice(0, 6).map(x => ({ id: x.id, label: x.label, fit: x.fit })),
        must_not_miss_open: ddx.mnm.filter(m => m.status !== 'cleared').slice(0, 6).map(m => ({ id: m.id, label: m.label })),
        observed_features: state.current().filter(o => o.status === 'present' || o.status === 'absent').map(o => ({ feature: o.feature_id, value: o.value_code, status: o.status, elapsed: t1(o.time_context.elapsed_bucket), severity: o.severity })),
        candidate_features: candidates.slice(0, 30).map(c => ({ feature: c.feature_id, label: c.label, type: c.type })),
        questions: ['relevant_to_separating_top_diseases', 'could_change_near_term_management', 'already_represented', 'urgency_now']
      };
    },
    async evaluate(state, ddx, candidates) {
      const t0 = Date.now();
      const prov = Jev.config.provider;
      if (prov === 'none') return null;
      const payload = Jev.buildPayload(state, ddx, candidates);
      try {
        let results;
        if (prov === 'mock') results = Jev.mock(payload);
        else if (prov === 'remote') results = await Jev.remote(payload);
        else throw new Error('unknown provider');
        return { ok: true, provider: prov, results, latency: Date.now() - t0, payload };
      } catch (e) {
        return { ok: false, provider: prov, results: {}, latency: Date.now() - t0, error: String(e && e.message || e), payload };
      }
    },
    /* 模擬 Jev: 決定的ヒューリスティック（A/B ハーネスと UI 確認用。臨床的意味はない） */
    mock(payload) {
      const kb = DDX.KB; const out = {};
      const tops = payload.current_top_diseases.map(x => x.id).concat(payload.must_not_miss_open.map(x => x.id));
      const observed = new Set(payload.observed_features.map(o => o.feature));
      for (const c of payload.candidate_features) {
        const rels = (kb.relByFeature[c.feature] || []).filter(r => tops.includes(r.d));
        const rel = Math.min(1, rels.length / Math.max(2, tops.length * 0.6));
        const f = kb.feature[c.feature];
        const dup = f.group && payload.observed_features.some(o => kb.feature[o.feature].group === f.group) ? 0.5 : 1;
        out[c.feature] = { relevant: rel > 0.3, relevance: Math.round(rel * dup * 100) / 100, confidence: rels.length ? 0.8 : 0.4 };
      }
      return out;
    },
    async remote(payload) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctrl && setTimeout(() => ctrl.abort(), Jev.config.timeoutMs);
      try {
        const res = await fetch(Jev.config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(Jev.config.apiKey ? { Authorization: 'Bearer ' + Jev.config.apiKey } : {}) }, body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        const out = {};
        for (const r of (j.results || [])) out[r.feature] = { relevant: !!r.relevant, relevance: Number(r.relevance ?? (r.relevant ? 1 : 0)), confidence: Number(r.confidence ?? 0.5) };
        return out;
      } finally { if (t) clearTimeout(t); }
    }
  };
  DDX.NextItem = { compute, featureApplicable };
  DDX.Jev = Jev;
})(typeof window !== 'undefined' ? window : globalThis);
