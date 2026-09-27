/* ============================================================
 * Differential Engine — 候補生成 → 適用判定 → スコアリング → Likely Top10 / Must-not-miss
 *  内部では事前確率×LR の事後確率を計算するが、画面は適合度(高/中/低)のみ（未較正のため%非表示）
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;
  const CLAMP = 3.5;       // 陰性側（なし）の上限: LR 1/33
  const CLAMP_POS = 4.6;   // 陽性側の上限: LR 100（内視鏡・画像・特異的検査の決め手が事前確率の差を覆せるように。2026-09-27）
  const CLAMP_DIAG = 9.2;  // 診断的所見（diag: true）: 特異度 0.9999・上限 LR 1万。その所見があればほぼその疾患と言えるもの
  const clamp = x => Math.max(-CLAMP, Math.min(CLAMP_POS, x));
  const lnLRpos = r => r.diag ? Math.min(CLAMP_DIAG, Math.log(r.sens / (1 - Math.max(r.spec, 0.9999)))) : clamp(Math.log(r.sens / (1 - r.spec)));
  const lnLRneg = r => clamp(Math.log((1 - r.sens) / r.spec));

  function ageIdx(b) { const i = KB().ageIndex[b]; return i === undefined ? null : i; }

  function applicable(d, state) {
    const c = state.context, rq = d.requires || {};
    if (rq.sex && c.sex && c.sex !== rq.sex) return { ok: false, reason: rq.sex === 'female' ? '女性のみ' : '男性のみ' };
    if (rq.pregnancy_not && rq.pregnancy_not.includes(c.pregnancy)) return { ok: false, reason: '妊娠可能性なし' };
    if (rq.pregnancy_in && !rq.pregnancy_in.includes(c.pregnancy)) return { ok: false, reason: '妊娠中のみ' };
    if (rq.age_max && ageIdx(c.age_band) !== null && ageIdx(c.age_band) > ageIdx(rq.age_max)) return { ok: false, reason: '年齢帯が対象外' };
    if (rq.age_min && ageIdx(c.age_band) !== null && ageIdx(c.age_band) < ageIdx(rq.age_min)) return { ok: false, reason: '年齢帯が対象外' };
    return { ok: true };
  }
  function contextMult(d, state) {
    let m = 0; const c = state.context;
    for (const r of d.mult || []) {
      const w = r.when; let hit = true;
      if (w.age_min) hit = hit && ageIdx(c.age_band) !== null && ageIdx(c.age_band) >= ageIdx(w.age_min);
      if (w.age_max) hit = hit && ageIdx(c.age_band) !== null && ageIdx(c.age_band) <= ageIdx(w.age_max);
      if (w.sex) hit = hit && c.sex === w.sex;
      if (w.feature) hit = hit && state.has(w.feature, null);
      if (hit) m += Math.log(r.x);
    }
    return m;
  }
  /* 1つの observation 集合に対して relation を評価: 'pos' | 'neg' | null(未取得) */
  function evalRelation(r, state) {
    const obs = state.get(r.f);
    const observed = obs.filter(o => o.status === 'present' || o.status === 'absent');
    if (!observed.length) return null;
    const present = observed.filter(o => o.status === 'present');
    let pos = false;
    if (present.length) pos = !r.values || present.some(o => r.values.includes(o.value_code));
    else if (r.values) {
      // 値付きの absent（「めまいなし」）は、その値を含む relation だけ否定。値なし absent は全体否定
      const absents = observed.filter(o => o.status === 'absent');
      if (!absents.some(o => !o.value_code || r.values.includes(o.value_code))) return null;
    }
    const stale = observed.every(o => state.isStale(o));
    return { pos, stale, obs: present[0] || observed[0] };
  }
  function evidenceFor(d, state) {
    const rels = KB().relByDisease[d.id] || [];
    const byF = {};
    for (const r of rels) (byF[r.f] = byF[r.f] || []).push(r);
    const support = [], refute = [], missing = [];
    let sum = 0;
    for (const fid in byF) {
      const group = byF[fid];
      const evals = group.map(r => ({ r, e: evalRelation(r, state) })).filter(x => x.e !== null);
      if (!evals.length) {
        const strongest = group.reduce((a, b) => Math.abs(lnLRpos(a)) + Math.abs(lnLRneg(a)) >= Math.abs(lnLRpos(b)) + Math.abs(lnLRneg(b)) ? a : b);
        missing.push({ feature_id: fid, key: !!strongest.key, weight: Math.abs(lnLRpos(strongest)) + Math.abs(lnLRneg(strongest)), values: strongest.values });
        continue;
      }
      const posOnes = evals.filter(x => x.e.pos);
      let chosen, ln;
      if (posOnes.length) { chosen = posOnes.reduce((a, b) => lnLRpos(a.r) >= lnLRpos(b.r) ? a : b); ln = lnLRpos(chosen.r); }
      else { chosen = evals.reduce((a, b) => lnLRneg(a.r) <= lnLRneg(b.r) ? a : b); ln = lnLRneg(chosen.r); }
      const stale = chosen.e.stale; if (stale) ln *= 0.5;
      sum += ln;
      const item = { feature_id: fid, lnLR: ln, key: !!chosen.r.key, pos: chosen.e.pos, stale, obs: chosen.e.obs };
      (ln >= 0 ? support : refute).push(item);
    }
    support.sort((a, b) => b.lnLR - a.lnLR); refute.sort((a, b) => a.lnLR - b.lnLR);
    missing.sort((a, b) => (b.key - a.key) || (b.weight - a.weight));
    return { sum, support, refute, missing };
  }
  function timeFit(d, state) {
    const co = state.chiefOnset();
    let ln = 0, notes = [];
    const om = d.onset ? d.onset[co.tier1] : 1;
    if (om !== undefined && om !== 1) { ln += Math.log(om); notes.push((om < 0.5 ? '発症時期が非典型' : om < 1 ? '発症時期はやや非典型' : '発症時期が典型')); }
    const tm = d.trend && d.trend[co.trend];
    if (tm) { ln += Math.log(tm); }
    return { ln, notes, onset: co.tier1, trend: co.trend };
  }
  /* 所見の尤度（事前確率を除いた部分）の差が TIE 以内の隣り合う疾患は「所見では区別できない」とみなし、
     有病率（事前確率・年齢/性別補正込み）の高い方を上にする。病理でしか区別できない疾患は有病率順になる（2026-09-27 オーナー指定）。
     入れ替えは所見の差が TIE を超える疾患をまたがない。上位 TIE_SCOPE 件のみ対象（表示と次項目の計算に十分） */
  const TIE = Math.log(3), TIE_SCOPE = 40;
  const lik = x => x.ev.sum + x.tf.ln;
  function prevalenceOrder(list) {
    const n = Math.min(list.length, TIE_SCOPE);
    for (let pass = 0; pass < n; pass++) {
      let swapped = false;
      for (let i = 0; i + 1 < n; i++) {
        const a = list[i], b = list[i + 1];
        if (b.logprior > a.logprior + 1e-9 && Math.abs(lik(a) - lik(b)) <= TIE) { list[i] = b; list[i + 1] = a; swapped = true; }
      }
      if (!swapped) break;
    }
    return list;
  }
  function fitLevel(p, rank) {
    if (p >= 0.15 || (rank === 1 && p >= 0.08)) return 'high';
    if (p >= 0.04) return 'mid';
    return 'low';
  }
  function compute(state, safety) {
    const kb = KB();
    const items = [], excluded = [];
    for (const d of kb.diseases) {
      const ap = applicable(d, state);
      if (!ap.ok) { excluded.push({ id: d.id, label: d.label, reason: ap.reason }); continue; }
      const ev = evidenceFor(d, state);
      const tf = timeFit(d, state);
      const logprior = Math.log(d.prior / (1 - d.prior)) + contextMult(d, state);
      const logodds = logprior + ev.sum + tf.ln;
      items.push({ id: d.id, label: d.label, d, ev, tf, logodds, logprior });
    }
    // 排他群は softmax、併存病態は独立 odds
    const excl = items.filter(x => !x.d.comorbid);
    const mx = Math.max(...excl.map(x => x.logodds));
    const Z = excl.reduce((s, x) => s + Math.exp(x.logodds - mx), 0);
    for (const x of items) {
      if (x.d.comorbid) { const o = Math.exp(x.logodds); x.p = o / (1 + o); }
      else x.p = Math.exp(x.logodds - mx) / Z;
    }
    const nObs = state.current().filter(o => o.status === 'present' || o.status === 'absent').length;
    const likely = prevalenceOrder(items.filter(x => !x.d.comorbid).sort((a, b) => (b.p - a.p) || (b.logprior - a.logprior) || (a.id < b.id ? -1 : 1)));
    const comorbid = items.filter(x => x.d.comorbid && x.p >= 0.25).sort((a, b) => b.p - a.p);
    const top = likely.slice(0, 10).map((x, i) => ({
      id: x.id, label: x.label, rank: i + 1, p: x.p, fit: fitLevel(x.p, i + 1), urgency: x.d.urgency, mnm: x.d.mnm,
      support: x.ev.support, refute: x.ev.refute, missing: x.ev.missing.slice(0, 6), timeNotes: x.tf.notes, note: x.d.note, comorbid: false
    }));
    // 適合度の表示は順位に対して単調にする（有病率順で上に来た疾患が下の疾患より低い適合度に見えないように）
    const FO = { low: 0, mid: 1, high: 2 };
    for (let i = top.length - 2; i >= 0; i--) if (FO[top[i + 1].fit] > FO[top[i].fit]) top[i].fit = top[i + 1].fit;
    for (const x of comorbid) top.push({ id: x.id, label: x.label, rank: null, p: x.p, fit: x.p >= 0.6 ? 'high' : 'mid', urgency: x.d.urgency, mnm: false, support: x.ev.support, refute: x.ev.refute, missing: x.ev.missing.slice(0, 6), timeNotes: [], note: '併存病態（独立評価）', comorbid: true });
    // Must-not-miss
    const mnm = [];
    for (const x of items.filter(x => x.d.mnm)) {
      const clear = x.d.clear || [];
      let cleared = 0, clearMissing = [], positiveKey = false, negativeKey = false;
      for (const fid of clear) {
        const rels = (kb.relByDisease[x.id] || []).filter(r => r.f === fid);
        const e = rels.length ? evalRelation(rels[0], state) : null;
        if (e === null) { clearMissing.push(fid); continue; }
        const anyPos = rels.some(r => { const ee = evalRelation(r, state); return ee && ee.pos; });
        if (anyPos) { if (rels.some(r => r.key)) positiveKey = true; }
        else if (!e.stale) cleared++;
      }
      for (const s of x.ev.refute) if (s.key && !s.stale) negativeKey = true;
      for (const s of x.ev.support) if (s.key) positiveKey = true;
      const frac = clear.length ? cleared / clear.length : 0;
      let status;
      // 決定的な陽性所見があれば決して「概ね除外」にしない
      if (x.p >= 0.10 || (positiveKey && x.p >= 0.01)) status = 'alert';
      else if (positiveKey) status = 'open';
      else if ((frac >= 0.67 && x.p < 0.05) || (negativeKey && frac >= 0.5 && x.p < 0.02)) status = 'cleared';
      else status = 'open';
      const openScore = (status === 'alert' ? 10 : 0) + (1 - frac) * (0.3 + x.p) * (x.d.urgency === 'emergent' ? 1 : 0.6);
      mnm.push({ id: x.id, label: x.label, p: x.p, status, positiveKey, clearedFrac: frac, clearMissing, openScore, note: x.d.note, urgency: x.d.urgency,
        support: x.ev.support, refute: x.ev.refute, missing: x.ev.missing.slice(0, 6), rank: likely.findIndex(y => y.id === x.id) + 1 });
    }
    mnm.sort((a, b) => (b.openScore - a.openScore) || (b.p - a.p));
    const posterior = Object.fromEntries(items.map(x => [x.id, x.p]));
    return {
      likely: top, mnm, excluded, posterior, items, ranked: likely.map(x => x.id),
      insufficient: nObs < 3, nObs, kb_version: kb.version,
      ranking_suppressed: !!(safety && safety.emergent)
    };
  }
  DDX.Differential = { compute, evidenceFor, applicable, lnLRpos, lnLRneg, fitLevel };
})(typeof window !== 'undefined' ? window : globalThis);
