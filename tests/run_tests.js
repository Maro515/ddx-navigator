/* 回帰テスト（合成症例）: node tests/run_tests.js */
const path = require('path');
for (const f of ['10_kb', '12_evidence', '15_demo', '18_bodymap', '20_state', '30_safety', '40_ddx', '50_next', '60_audit', '65_extract']) require(path.join(__dirname, '..', 'build', f + '.js'));
const D = globalThis.DDX, KB = D.KB;
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const results = []; let fails = 0;
function check(name, ok, detail) { results.push({ name, ok, detail }); if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); }

/* ---- 合成症例生成: 疾患 d の典型例（関係の sens で陽性/陰性をサンプル） ---- */
const TYPICAL_ONSET = { minutes: ['min_10_30', 'min_30_60'], hours: ['h_1_3', 'h_3_6', 'h_6_12', 'h_12_24'], days: ['d_1_2', 'd_3_7'], weeks: ['w_1_2'], months: ['m_1_3'] };
function contextFor(d) {
  const rq = d.requires || {};
  const sex = rq.sex || pick(['female', 'male']);
  let bands = ['18-29', '30-39', '40-49', '50-59', '60-69', '70-79', '80+'];
  if (rq.age_max) bands = bands.filter(b => KB.ageIndex[b] <= KB.ageIndex[rq.age_max]);
  for (const m of d.mult || []) { if (m.when.age_min && m.x > 1 && rnd() < 0.7) bands = bands.filter(b => KB.ageIndex[b] >= KB.ageIndex[m.when.age_min]); }
  const age_band = pick(bands);
  const pregnancy = sex === 'male' ? 'no' : (rq.pregnancy_not ? 'possible' : pick(['no', 'possible', 'unknown']));
  return { age_band, sex, setting: 'emergency', pregnancy, trauma: 'no' };
}
function synth(d, nFeat) {
  const rels = KB.relByDisease[d.id].slice();
  const ctx = contextFor(d);
  const byF = {}; for (const r of rels) (byF[r.f] = byF[r.f] || []).push(r);
  const fids = Object.keys(byF).filter(f => D.NextItem.featureApplicable(KB.feature[f], ctx));
  // 主訴を優先的に含める
  const cc = fids.filter(f => KB.feature[f].type === 'chief_complaint');
  const chosen = new Set(cc.slice(0, 2));
  const rest = fids.filter(f => !chosen.has(f)); while (chosen.size < Math.min(nFeat, fids.length) && rest.length) { const i = Math.floor(rnd() * rest.length); chosen.add(rest.splice(i, 1)[0]); }
  const onsetW = d.onset; const tier1s = Object.keys(onsetW).filter(k => k !== 'unknown'); const best = tier1s.reduce((a, b) => onsetW[a] >= onsetW[b] ? a : b);
  const obs = [];
  for (const fid of chosen) {
    const f = KB.feature[fid]; const rs = byF[fid]; const r = rs.reduce((a, b) => a.sens >= b.sens ? a : b);
    const pos = rnd() < r.sens;
    let o;
    if (pos) o = { feature_id: fid, status: 'present', value_code: f.values ? (r.values ? pick(r.values) : pick(f.values.map(v => v.code))) : null };
    else if (f.values) { const neg = f.values.map(v => v.code).filter(c => !r.values || !r.values.includes(c)); o = neg.length ? { feature_id: fid, status: 'present', value_code: pick(neg) } : { feature_id: fid, status: 'absent' }; }
    else o = { feature_id: fid, status: 'absent' };
    const bucket = f.anchor === 'onset' ? pick(TYPICAL_ONSET[best] || ['hours']) : f.anchor === 'observation' ? 'min_10_30' : f.anchor === 'collection' ? 'h_1_3' : f.anchor === 'imaging' ? 'h_1_3' : f.anchor === 'history' ? 'w_1_2' : null;
    o.time_context = { elapsed_bucket: bucket, trend: f.type === 'chief_complaint' ? pick(['worsening', 'stable']) : 'unknown' };
    if (f.sev) o.severity = pick(['moderate', 'severe']);
    obs.push(o);
  }
  return { ctx, obs, ref: d.id };
}
const N_PER = 8;
const cases = [];
for (const d of KB.diseases.filter(x => !x.comorbid)) for (let i = 0; i < N_PER; i++) cases.push(synth(d, 6 + Math.floor(rnd() * 5)));
console.log(`合成症例 ${cases.length} 件（${KB.diseases.filter(x => !x.comorbid).length} 疾患 × ${N_PER}）`);

function run(c, order) {
  const s = new D.ClinicalState({ context: c.ctx });
  const obs = order ? order.map(i => c.obs[i]) : c.obs;
  for (const o of obs) s.add(JSON.parse(JSON.stringify(o)));
  return { s, r: D.runSync(s) };
}
/* 1. Top-k recall / MNM */
let top1 = 0, top3 = 0, top5 = 0, top10 = 0, mnmMiss = 0, mnmTotal = 0, mnmClearedRaw = 0, rr = 0;
for (const c of cases) {
  const { r } = run(c);
  const ids = r.ddx.likely.filter(x => !x.comorbid).map(x => x.id); const k = ids.indexOf(c.ref);
  if (k === 0) top1++; if (k >= 0 && k < 3) top3++; if (k >= 0 && k < 5) top5++; if (k >= 0) top10++; if (k >= 0) rr += 1 / (k + 1);
  if (KB.disease[c.ref].mnm) { mnmTotal++; const m = r.ddx.mnm.find(x => x.id === c.ref); if (!m) mnmMiss++; else if (m.status === 'cleared') { mnmClearedRaw++; const negKey = m.refute.some(z => z.key); if (m.positiveKey || !(negKey || m.clearedFrac >= 0.67)) mnmMiss++; } }
}
const n = cases.length;
console.log(`Top1 ${(top1 / n * 100).toFixed(1)}%  Top3 ${(top3 / n * 100).toFixed(1)}%  Top5 ${(top5 / n * 100).toFixed(1)}%  Top10 ${(top10 / n * 100).toFixed(1)}%  MRR ${(rr / n).toFixed(3)}`);
check('Top10 recall ≥ 90%', top10 / n >= 0.9, `${(top10 / n * 100).toFixed(1)}%`);
check('Top3 recall ≥ 60%', top3 / n >= 0.6, `${(top3 / n * 100).toFixed(1)}%`);
check('MNM「概ね除外」は決定的陰性 or 解除項目≥2/3 のときのみ（陽性キー所見があれば不可）', mnmMiss === 0, `違反 ${mnmMiss}/${mnmTotal}、参考: 偽陰性検査による cleared ${mnmClearedRaw}/${mnmTotal}`);

/* 2. 入力順序不変性 */
let orderFail = 0;
for (const c of cases.slice(0, 120)) {
  const a = run(c); const idx = c.obs.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const b = run(c, idx);
  const ta = a.r.ddx.likely.map(x => x.id).join(','), tb = b.r.ddx.likely.map(x => x.id).join(',');
  const na = a.r.next.top.map(x => x.feature_id).join(','), nb = b.r.next.top.map(x => x.feature_id).join(',');
  if (ta !== tb || na !== nb || a.s.hash() !== b.s.hash()) orderFail++;
}
check('入力順序不変性 (Top10/Next5/hash 同一)', orderFail === 0, `${orderFail}/120 差異`);

/* 3. 同一 feature の再入力: 時間が新しい方が current になる（入力順に依らない） */
{
  const s1 = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } });
  s1.add({ feature_id: 'crp', value_code: 'lt1', time_context: { elapsed_bucket: 'd_1_2' } }); s1.add({ feature_id: 'crp', value_code: 'gt10', time_context: { elapsed_bucket: 'h_1_3' } });
  const s2 = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } });
  s2.add({ feature_id: 'crp', value_code: 'gt10', time_context: { elapsed_bucket: 'h_1_3' } }); s2.add({ feature_id: 'crp', value_code: 'lt1', time_context: { elapsed_bucket: 'd_1_2' } });
  check('再測定は時間が新しい方を採用（順序非依存）', s1.get('crp')[0].value_code === 'gt10' && s2.get('crp')[0].value_code === 'gt10' && s1.hash() === s2.hash());
  check('前回との比較トレンド', s1.trendOf(s1.get('crp')[0]) === 'up');
}
/* 4. 欠損区別: なし / 不明 / 未評価 / 結果待ち */
{
  const base = () => { const s = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } }); s.add({ feature_id: 'abd_pain', value_code: 'rlq', severity: 'severe', time_context: { elapsed_bucket: 'h_3_6', trend: 'worsening' } }); return s; };
  const s0 = base(); const p0 = D.runSync(s0).ddx.posterior.appendicitis;
  const sA = base(); sA.add({ feature_id: 'tender_rlq', status: 'absent', time_context: { elapsed_bucket: 'min_lt10' } }); const pA = D.runSync(sA).ddx.posterior.appendicitis;
  const sU = base(); sU.add({ feature_id: 'tender_rlq', status: 'unknown' }); const pU = D.runSync(sU).ddx.posterior.appendicitis;
  const sN = base(); sN.add({ feature_id: 'tender_rlq', status: 'not_assessed' }); const rN = D.runSync(sN);
  const sP = base(); sP.add({ feature_id: 'ct', status: 'pending' }); const rP = D.runSync(sP);
  check('「なし」は確率を下げ、「不明」は変えない', pA < p0 && Math.abs(pU - p0) < 1e-9, `p0=${p0.toFixed(3)} absent=${pA.toFixed(3)} unknown=${pU.toFixed(3)}`);
  check('「未評価/実施不可」は次項目候補から外れる', !rN.next.all.some(x => x.feature_id === 'tender_rlq') && !rN.next.forced.some(x => x.feature_id === 'tender_rlq'));
  check('「結果待ち」は次項目候補から外れる', !rP.next.all.some(x => x.feature_id === 'ct'));
}
/* 5. 矛盾検出 */
{
  const s = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } });
  s.add({ feature_id: 'obstipation', status: 'present', time_context: { elapsed_bucket: 'd_1_2' } }); s.add({ feature_id: 'diarrhea', value_code: 'watery', time_context: { elapsed_bucket: 'd_1_2' } });
  const r = D.runSync(s); check('矛盾検出 C01（排便停止 vs 下痢）', r.safety.contradictions.some(c => c.id === 'C01'));
  const s2 = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } }); s2.add({ feature_id: 'hcg', value_code: 'pos', time_context: { elapsed_bucket: 'h_1_3' } });
  check('矛盾検出 C04（男性で hCG 陽性）', D.runSync(s2).safety.contradictions.some(c => c.id === 'C04'));
}
/* 6. ノイズ耐性: 無関係な陰性 feature を 5 個追加しても参照診断が Top10 に残る */
{
  let drop = 0, tested = 0;
  for (const c of cases.slice(0, 100)) {
    const a = run(c); const ids = a.r.ddx.likely.map(x => x.id); if (ids.indexOf(c.ref) < 0 || ids.indexOf(c.ref) > 4) continue; tested++;
    const s = a.s; const related = new Set(KB.relByDisease[c.ref].map(r => r.f));
    const noise = KB.features.filter(f => !related.has(f.id) && !s.isObserved(f.id) && D.NextItem.featureApplicable(f, s.context) && f.type !== 'vital').slice(0, 5);
    for (const f of noise) s.add({ feature_id: f.id, status: 'absent', time_context: { elapsed_bucket: 'min_lt10' } });
    const r2 = D.runSync(s); if (r2.ddx.likely.map(x => x.id).indexOf(c.ref) < 0) drop++;
  }
  check('ノイズ耐性（無関係陰性×5 で Top10 から脱落しない）', drop === 0, `${drop}/${tested}`);
}
/* 7. 時間境界: 12-24時間 と 1-2日 は tier1 が異なり、freshness 判定が境界で切り替わる */
{
  const s = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } });
  const o1 = s.add({ feature_id: 'hr', value_code: '100_120', time_context: { elapsed_bucket: 'h_1_3' } });
  const o2 = s.add({ feature_id: 'temp', value_code: '38_39', time_context: { elapsed_bucket: 'h_3_6' } });
  check('freshness: バイタル 1-3h は新鮮、3-6h は古い', !s.isStale(o1) && s.isStale(o2));
  check('tier1 変換: h_12_24→hours, d_1_2→days', KB.time.tier1Of('h_12_24') === 'hours' && KB.time.tier1Of('d_1_2') === 'days');
}
/* 8. Safety: ショックは通常ランキングより先に、強制項目が出る */
{
  const s = new D.ClinicalState({ context: { age_band: '60-69', sex: 'male', pregnancy: 'no' } });
  s.add({ feature_id: 'abd_pain', value_code: 'diffuse', severity: 'severe', time_context: { elapsed_bucket: 'h_1_3', trend: 'worsening' } });
  s.add({ feature_id: 'sbp', value_code: 'lt90', time_context: { elapsed_bucket: 'min_lt10' } });
  const r = D.runSync(s);
  check('Safety S01 ショック → emergent + forced に乳酸', r.safety.emergent && r.next.forced.some(x => x.feature_id === 'lactate'));
  const s2 = new D.ClinicalState({ context: { age_band: 'lt18', sex: 'male', pregnancy: 'no' } }); s2.add({ feature_id: 'abd_pain', value_code: 'rlq', time_context: { elapsed_bucket: 'hours' } });
  check('適用外（小児）検出', D.runSync(s2).safety.scope.status === 'out_of_scope');
  const s3 = new D.ClinicalState({ context: { age_band: '18-29', sex: 'female', pregnancy: 'possible' } }); s3.add({ feature_id: 'abd_pain', value_code: 'llq', time_context: { elapsed_bucket: 'hours' } });
  check('前提 P01: 妊娠可能性のある女性で hCG が強制項目', D.runSync(s3).next.forced.some(x => x.feature_id === 'hcg'));
  const s4 = new D.ClinicalState({ context: { age_band: '18-29', sex: 'male', pregnancy: 'no' } }); s4.add({ feature_id: 'abd_pain', value_code: 'llq', time_context: { elapsed_bucket: 'hours' } });
  const r4 = D.runSync(s4);
  check('男性では hCG/付属器診察が候補に出ない', !r4.next.all.some(x => ['hcg', 'adnexal_tender'].includes(x.feature_id)) && !r4.ddx.likely.some(x => x.id === 'ectopic_pregnancy'));
}
/* 9. MNM 解除: hCG 陰性で異所性妊娠が「概ね除外」 */
{
  const s = new D.ClinicalState({ context: { age_band: '18-29', sex: 'female', pregnancy: 'possible' } });
  s.add({ feature_id: 'abd_pain', value_code: 'llq', time_context: { elapsed_bucket: 'hours' } }); s.add({ feature_id: 'hcg', value_code: 'neg', time_context: { elapsed_bucket: 'min_30_60' } });
  const m = D.runSync(s).ddx.mnm.find(x => x.id === 'ectopic_pregnancy');
  check('hCG 陰性で異所性妊娠が概ね除外', m && m.status === 'cleared', m && m.status);
}
/* 9b. エマージェンシー枠: RLQ 痛の若年女性で異所性妊娠が枠に入り、hCG 陰性で除外済みへ移る */
{
  const s = new D.ClinicalState({ context: { age_band: '18-29', sex: 'female', pregnancy: 'possible' } });
  s.add({ feature_id: 'abd_pain', value_code: 'rlq', severity: 'severe', time_context: { elapsed_bucket: 'h_3_6', trend: 'worsening' } });
  let r = D.runSync(s); const em = r.next.emergency;
  check('緊急枠: 支持所見のある重大疾患のみ枠に入る（異所性妊娠・卵巣捻転・嵌頓ヘルニア）', ['ectopic_pregnancy', 'ovarian_torsion', 'incarcerated_hernia'].every(id => em.frame.some(m => m.id === id)) && !em.frame.some(m => m.id === 'ruptured_aaa'), em.frame.map(m => m.id).join(','));
  check('緊急枠: 除外の推奨順に複数疾患を同時に除外する項目が上位', em.order.length > 0 && em.order[0].clears.length >= 2, em.order[0] && em.order[0].label);
  check('緊急枠: 強制項目(hCG)に除外対象が付く', r.next.forced.some(x => x.feature_id === 'hcg' && x.clears && x.clears.some(c => c.id === 'ectopic_pregnancy')));
  s.add({ feature_id: 'hcg', value_code: 'neg', time_context: { elapsed_bucket: 'min_30_60' } });
  r = D.runSync(s);
  check('緊急枠: hCG 陰性で異所性妊娠が除外済みへ', r.next.emergency.cleared.some(m => m.id === 'ectopic_pregnancy') && !r.next.emergency.frame.some(m => m.id === 'ectopic_pregnancy'));
  check('鑑別枠: 可能性順 Top10 に関係する項目のみで構成', r.next.differential.top.length === 5 && r.next.differential.top.every(it => (KB.relByFeature[it.feature_id] || []).some(rel => r.ddx.likely.some(x => x.id === rel.d))));
}
/* 9c. 不明/実施不可 は候補から消える。画像所見の否定は登録しない。CT の腸閉塞所見は ct sbo へ */
{
  const s = new D.ClinicalState({ context: { age_band: '18-29', sex: 'female', pregnancy: 'possible' } });
  s.add({ feature_id: 'abd_pain', value_code: 'rlq', severity: 'severe', time_context: { elapsed_bucket: 'h_3_6', trend: 'worsening' } });
  let r = D.runSync(s); const wasForced = r.next.forced.some(x => x.feature_id === 'hcg');
  s.add({ feature_id: 'hcg', status: 'unknown' }); r = D.runSync(s);
  const gone = !r.next.forced.some(x => x.feature_id === 'hcg') && !r.next.all.some(x => x.feature_id === 'hcg') && !r.next.emergency.order.some(x => x.feature_id === 'hcg');
  check('「不明」を選ぶと強制項目・候補・除外順から消える', wasForced && gone);
  s.add({ feature_id: 'us', status: 'not_assessed' }); r = D.runSync(s);
  check('「実施不可」を選ぶと候補・除外順から消える', !r.next.all.some(x => x.feature_id === 'us') && !r.next.emergency.order.some(x => x.feature_id === 'us'));
  const e1 = D.Extract.local('造影CTで小腸の拡張とニボーあり。CT：free airなし。超音波で虫垂腫大は指摘できず。CTでは胆嚢結石のみ。');
  const has = (f, st, v) => e1.items.some(i => i.feature_id === f && i.status === st && (v === undefined || i.value_code === v));
  check('画像: CT の腸管拡張/ニボー→ct sbo、否定所見は登録せず、胆嚢結石は胆石へ', has('ct', 'present', 'sbo') && !e1.items.some(i => i.feature_id === 'xray') && !has('ct', 'absent') && !has('us', 'present', 'appendix') && !has('ct', 'present', 'stone') && has('gallstone_hx', 'present'), JSON.stringify(e1.items.map(i => i.feature_id + ':' + i.status + ':' + i.value_code)));
}
/* 10. Jev 障害時の fallback（remote が失敗しても Safety/baseline は継続） */
(async () => {
  const s = new D.ClinicalState({ context: { age_band: '30-39', sex: 'male', pregnancy: 'no' } });
  s.add({ feature_id: 'abd_pain', value_code: 'rlq', severity: 'severe', time_context: { elapsed_bucket: 'h_3_6', trend: 'worsening' } });
  D.Jev.config.provider = 'remote'; D.Jev.config.endpoint = 'http://127.0.0.1:9/nope'; D.Jev.config.timeoutMs = 500;
  const r = await D.run(s, { noLog: true });
  check('Jev remote 障害 → ok=false でも Next Top5 が出る', r.next.jev.enabled && r.next.jev.ok === false && r.next.top.length === 5, r.next.jev.error);
  D.Jev.config.provider = 'mock';
  const r2 = await D.run(s, { noLog: true });
  check('Jev mock → ok=true, latency 記録', r2.next.jev.ok === true && typeof r2.next.jev.latency === 'number');
  const base = D.runSync(s);
  check('Jev あり/なしで Safety と Top10 は不変（Next-Item のみ変化し得る）', JSON.stringify(base.ddx.likely.map(x => x.id)) === JSON.stringify(r2.ddx.likely.map(x => x.id)) && JSON.stringify(base.safety.alerts) === JSON.stringify(r2.safety.alerts));
  D.Jev.config.provider = 'none';
  /* 11. デモ症例（フリーテキスト）がローカル解析で項目化され計算できる */
  let demoErr = 0, demoEmpty = 0;
  for (const dc of D.DEMO_TEXT) { try { const st = new D.ClinicalState({}); let n = 0; for (const t of dc.steps) { const r = D.Extract.local(D.Extract.scrub(t).text); Object.assign(st.context, r.context); for (const it of r.items) { st.add(it); n++; } } if (!n) demoEmpty++; D.runSync(st); } catch (e) { demoErr++; console.error(dc.label, e); } }
  check('デモ症例（テキスト）が全て解析・計算可能', demoErr === 0 && demoEmpty === 0, `err ${demoErr}, empty ${demoEmpty}`);
  /* 11b. PII 除去 */
  {
    const sc = D.Extract.scrub('山田太郎さん 45歳女性 ID 1234567 2024/9/25受診 090-1234-5678 東京都新宿区西新宿1-1 taro@example.com。3日前から腹痛。');
    check('PII除去: 氏名・ID・日付・電話・住所・メールを除去し年齢は年齢帯へ', !/山田|1234567|2024|090|新宿|example/.test(sc.text) && /40代/.test(sc.text) && /3日前/.test(sc.text), sc.text);
  }
  /* 11c. ローカル抽出 */
  {
    const r = D.Extract.local('30代男性。昨日から右下腹部痛が悪化。嘔吐なし。反跳痛あり。体温38.2、脈拍104、血圧118/70。WBC 13,200、CRP 5.8。');
    const has = (f, st, v) => r.items.some(i => i.feature_id === f && i.status === st && (v === undefined || i.value_code === v));
    check('ローカル抽出: 部位付き腹痛・否定・数値カテゴリ化・文脈', has('abd_pain', 'present', 'rlq') && !has('abd_pain', 'present', 'supra') && has('vomiting', 'absent') && has('rebound_guarding', 'present') && has('temp', 'present', '38_39') && has('hr', 'present', '100_120') && has('wbc', 'present', '10_15') && has('crp', 'present', '5_10') && r.context.sex === 'male' && r.context.age_band === '30-39', JSON.stringify(r.items.map(i => i.feature_id + ':' + i.status + ':' + i.value_code)));
    const v = D.Extract.validate({ items: [{ feature_id: 'abd_pain', value_code: 'rlq', status: 'present', elapsed_bucket: 'h_1_3', trend: 'worsening', severity: 'severe', quote: '' }, { feature_id: 'nope', value_code: null, status: 'present', elapsed_bucket: null, trend: null, severity: null, quote: '' }, { feature_id: 'temp', value_code: 'bogus', status: 'present', elapsed_bucket: null, trend: null, severity: null, quote: '' }], context: { age_band: '40-49', sex: 'female', pregnancy: 'possible' }, unmapped: [] });
    check('LLM 出力の検証: カタログ外の feature/value を捨てる', v.items.length === 1 && v.context.age_band === '40-49');
  }
  /* 12. KB 整合性 */
  const bad = KB.relations.filter(r => r.values && r.values.some(v => !KB.feature[r.f].values || !KB.feature[r.f].values.some(x => x.code === v)));
  check('KB: relation の値コードが feature 定義に存在', bad.length === 0, bad.map(r => r.d + '/' + r.f).join(','));
  const badClear = KB.diseases.flatMap(d => (d.clear || []).filter(f => !KB.relByDisease[d.id].some(r => r.f === f)).map(f => d.id + '/' + f));
  check('KB: MNM clear feature に relation が存在', badClear.length === 0, badClear.join(','));
  const badRule = [].concat(KB.safetyRules, KB.prerequisiteRules, KB.contradictionRules).flatMap(r => JSON.stringify(r.when).match(/"f":"([a-z_0-9]+)"/g) || []).map(x => x.slice(5, -1)).filter(f => !KB.feature[f]);
  check('KB: ルール内の feature が定義済み', badRule.length === 0, badRule.join(','));
  /* 13. 根拠台帳ポリシー */
  const pol = KB.evidencePolicy; const evBad = [];
  for (const e of KB.evidence) {
    if (!e.pmid || !/^\d+$/.test(String(e.pmid))) evBad.push(e.evidence_id + ':pmid');
    const applied = e.findings.filter(f => f.feature_id !== null && !f.ref_only && !f.composite && f.sens != null);
    const classicOK = KB.evidencePolicy.classic_any_type ? true : applied.every(f => KB.isClassicFeature(f.feature_id)); // オーナー承認により古典文献は全項目採用可
    if (!(e.year >= pol.since) && !(e.classic && classicOK)) evBad.push(e.evidence_id + ':year(' + e.year + ', classic例外で数値採用できるのは診察/バイタル所見のみ)');
    if (!(e.n >= pol.min_n)) evBad.push(e.evidence_id + ':n');
    for (const d of e.diseases) if (!KB.disease[d]) evBad.push(e.evidence_id + ':disease ' + d);
    for (const f of e.findings) { if (f.feature_id === null) continue; if (!KB.feature[f.feature_id]) evBad.push(e.evidence_id + ':feature ' + f.feature_id); else if (f.values && f.values.some(v => !KB.feature[f.feature_id].values || !KB.feature[f.feature_id].values.some(x => x.code === v))) evBad.push(e.evidence_id + ':value ' + f.feature_id); }
  }
  check('根拠台帳: PMID・2016年以降・N≥300・ID整合', evBad.length === 0, evBad.join(', '));
  const dup = KB.evidence.filter(e => !e.alias_of).map(e => e.pmid).filter((p, i, a) => a.indexOf(p) !== i);
  check('根拠台帳: PMID 重複なし（alias 除く）', dup.length === 0, dup.join(','));
  const pBad = (KB.pendingEvidence || []).filter(x => !x.pmid || x.diseases.some(d => !KB.disease[d]) || x.features.some(f => !KB.feature[f])).map(x => x.pmid);
  check('本文確認待ちリスト: PMID・疾患/feature ID 整合', pBad.length === 0, pBad.join(','));
  const gBad = KB.guidelines.filter(g => !g.pmid || !(g.year >= pol.since) || g.diseases.some(d => !KB.disease[d])).map(g => g.id);
  check('参照ガイドライン: PMID・2016年以降・疾患ID整合', gBad.length === 0, gBad.join(','));
  const badSens = KB.relations.filter(r => !(r.sens > 0 && r.sens < 1 && r.spec > 0 && r.spec < 1)).map(r => r.d + '/' + r.f);
  check('全 relation の sens/spec が (0,1) の範囲', badSens.length === 0, badSens.join(','));
  console.log(`根拠カバレッジ: 文献値(感度+特異度) ${KB.evidenceCoverage.with_values} / 感度のみ ${KB.evidenceCoverage.partial} / 参照付き ${KB.evidenceCoverage.with_ref} / 全 ${KB.evidenceCoverage.total} 関係; 文献 ${KB.evidenceCoverage.sources} 件 + ガイドライン ${KB.evidenceCoverage.guidelines} 件`);
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
