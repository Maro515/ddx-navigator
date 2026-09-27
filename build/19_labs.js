/* ============================================================
 * 検査値パネル — 救急で測る血算＋生化学の一覧。数値 → KB の値コードへ（閾値はコード側で判定）
 *  単位・基準値: 国立がん研究センター中央病院 臨床検査科「検査基準値一覧」
 *   https://www.ncc.go.jp/jp/ncch/division/clinical_laboratory/kensa.pdf（2026-09-26 参照）
 *  Hb の低下閾値はオーナー指定（男 <13 / 女 <12）。乳酸・NT-proBNP は同表に無く一般的単位。
 *  map: null の項目は KB に対応 feature が無く、テキストとして入力欄に残す。map は {f, code, status?} かその配列を返す
 *  異常の閾値は臨床的カットオフ（2026-09-27 オーナー指定: 低Na <135、高K >5.5、低K <3.5、高Ca >10.5、Plt <15）
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const L = (id, label, unit, map, o) => Object.assign({ id, label, unit, map }, o || {});
  const male = ctx => ctx && ctx.sex === 'male';
  DDX.LABS = {
    source: { label: '国立がん研究センター 検査基準値一覧', url: 'https://www.ncc.go.jp/jp/ncch/division/clinical_laboratory/kensa.pdf' },
    groups: [
      { label: '血算', items: [
        L('wbc', 'WBC', '10³/μL', v => ({ f: 'wbc', code: v < 4000 ? 'lt4' : v <= 10000 ? '4_10' : v <= 15000 ? '10_15' : 'gt15' }), { hint: '基準 3.3～8.6。例 12.3（12300 と入れても可）', norm: v => v < 100 ? v * 1000 : v }),
        L('hb', 'Hb', 'g/dL', (v, ctx) => ({ f: 'hb', code: v < (male(ctx) ? 13 : 12) ? 'low' : 'normal' }), { hint: '低下: 男 <13 / 女 <12（基準 男 13.7～16.8 / 女 11.6～14.8。性別未設定は 12）' }),
        L('plt', 'Plt', '10⁴/μL', v => v < 15 ? { f: 'chronic_liver_labs', code: 'plt_low' } : { f: 'chronic_liver_labs', code: 'plt_low', status: 'absent' }, { hint: '減少: <15（臨床的定義 15万/μL）。基準 15.8～34.8。12.3 のように入力（123000 も可）', norm: v => v >= 1000 ? v / 10000 : v >= 100 ? v / 10 : v })
      ] },
      { label: '生化学', items: [
        L('crp', 'CRP', 'mg/dL', v => ({ f: 'crp', code: v < 1 ? 'lt1' : v <= 5 ? '1_5' : v <= 10 ? '5_10' : 'gt10' }), { hint: '基準 0.14 以下。区分 1 / 5 / 10' }),
        L('ast', 'AST', 'U/L', v => ({ f: 'liver_enz', code: v > 30 ? 'elevated' : 'normal' }), { hint: '基準 13～30' }),
        L('alt', 'ALT', 'U/L', (v, ctx) => ({ f: 'liver_enz', code: v > (male(ctx) ? 42 : 23) ? 'elevated' : 'normal' }), { hint: '基準 男 10～42 / 女 7～23' }),
        L('alp', 'ALP', 'U/L', v => ({ f: 'alp_ggt', code: v > 322 ? 'elevated' : 'normal' }), { hint: '基準 106～322（JSCC 法）' }),
        L('ggt', 'γ-GTP', 'U/L', (v, ctx) => ({ f: 'alp_ggt', code: v > (male(ctx) ? 64 : 32) ? 'elevated' : 'normal' }), { hint: '基準 男 13～64 / 女 9～32' }),
        L('tbil', 'T-Bil', 'mg/dL', v => ({ f: 'bili', code: v > 1.5 ? 'elevated' : 'normal' }), { hint: '基準 0.4～1.5' }),
        L('amy', 'アミラーゼ', 'U/L', v => ({ f: 'lipase', code: v >= 396 ? 'ge3x' : v > 132 ? 'lt3x' : 'normal' }), { hint: '基準 44～132（3倍 = 396）' }),
        L('lip', 'リパーゼ', 'U/L', v => ({ f: 'lipase', code: v >= 165 ? 'ge3x' : v > 55 ? 'lt3x' : 'normal' }), { hint: '基準 13～55（3倍 = 165）' }),
        L('bun', 'BUN', 'mg/dL', v => ({ f: 'renal', code: v > 20 ? 'elevated' : 'normal' }), { hint: '基準 8～20' }),
        L('cre', 'Cre', 'mg/dL', (v, ctx) => ({ f: 'renal', code: v > (male(ctx) ? 1.07 : 0.79) ? 'elevated' : 'normal' }), { hint: '基準 男 0.65～1.07 / 女 0.46～0.79' }),
        L('na', 'Na', 'mmol/L', v => ({ f: 'electrolyte', code: 'hypona', status: v < 135 ? 'present' : 'absent' }), { hint: '低Na: <135（臨床的定義）。基準 138～145' }),
        L('k', 'K', 'mmol/L', v => [{ f: 'electrolyte', code: 'hyperk', status: v > 5.5 ? 'present' : 'absent' }, { f: 'electrolyte', code: 'hypok', status: v < 3.5 ? 'present' : 'absent' }], { hint: '高K: >5.5 / 低K: <3.5（臨床的定義）。基準 3.6～4.8' }),
        L('cl', 'Cl', 'mmol/L', null, { hint: '基準 101～108（記録のみ）' }),
        L('ca', 'Ca', 'mg/dL', v => ({ f: 'electrolyte', code: 'hyperca', status: v > 10.5 ? 'present' : 'absent' }), { hint: '高Ca: >10.5（臨床的定義。低Alb なら補正Ca を入力）。基準 8.8～10.1' }), L('p', 'P（無機リン）', 'mg/dL', null, { hint: '基準 2.7～4.6（記録のみ）' }), L('mg', 'Mg', 'mg/dL', null, { hint: '基準 1.8～2.4（記録のみ）' }),
        L('glu', '血糖', 'mg/dL', v => ({ f: 'glucose', code: v > 250 ? 'gt250' : 'normal' }), { hint: '基準 73～109（血清）。>250 で高血糖' }),
        L('lac', '乳酸', 'mmol/L', v => ({ f: 'lactate', code: v < 2 ? 'lt2' : v <= 4 ? '2_4' : 'gt4' }), { hint: '区分 2 / 4' }),
        L('ck', 'CK', 'U/L', (v, ctx) => ({ f: 'ck', code: v > (male(ctx) ? 248 : 153) ? 'elevated' : 'normal' }), { hint: '上昇: 基準上限超（男 248 / 女 153）' }), L('ckmb', 'CK-MB', 'ng/mL', null, { hint: '基準 3.6 以下（記録のみ）' }),
        L('ldh', 'LD', 'U/L', v => ({ f: 'ldh', code: v > 222 ? 'elevated' : 'normal' }), { hint: '上昇: >222（基準 124～222）' }),
        L('ddimer', 'D-dimer', 'μg/mL', v => ({ f: 'ddimer', code: v >= 1.0 ? 'elevated' : 'normal' }), { hint: '基準 1.0 未満' }),
        L('tni', 'トロポニンI', 'ng/mL', v => ({ f: 'troponin', code: v > 0.03 ? 'pos' : 'neg' }), { hint: '基準 0.03 以下（施設の hs 法では要調整）' }),
        L('bnp', 'BNP', 'pg/mL', null, { hint: '基準 18.4 以下（記録のみ）' }), L('ntprobnp', 'NT-proBNP', 'pg/mL', null, { hint: '記録のみ' }),
        L('nh3', 'アンモニア', 'μg/dL', v => ({ f: 'ammonia', code: v > 66 ? 'elevated' : 'normal' }), { hint: '上昇: >66（基準 12～66）' })
      ] },
      { label: '尿検査（一般）', items: [
        L('ua', '尿定性', '', null, { choice: [['normal', '正常（潜血− 白血球−）'], ['pyuria', '膿尿（白血球エステラーゼ＋）'], ['hematuria', '血尿（潜血＋）'], ['both', '膿尿＋血尿']], f: 'urinalysis' })
      ] }
    ],
    byId: {}
  };
  for (const gr of DDX.LABS.groups) for (const it of gr.items) DDX.LABS.byId[it.id] = it;

  /* 入力済みの検査値すべて → 所見のリスト（純粋関数）。
     - 同じ項目に書く検査（AST/ALT、BUN/Cre、アミラーゼ/リパーゼ、ALP/γ-GTP）は最も異常な値を採る（後から入れた正常値で上書きしない）
     - 複数選択の項目（電解質など）は値ごとに「あり/なし」
     - AST と ALT が両方あり上昇していれば AST/ALT パターンを付ける
     戻り値: [{ f, code, status, from: [検査ID…] }] */
  DDX.LABS.resolve = function (values, ctx) {
    const KB = DDX.KB, raw = [];
    for (const id in values) {
      const it = DDX.LABS.byId[id], v = values[id];
      if (!it || !it.map || typeof v !== 'number') continue;
      for (const x of [].concat(it.map(v, ctx || {}))) if (x && KB.feature[x.f]) raw.push({ f: x.f, code: x.code, status: x.status || 'present', from: id });
    }
    const groups = {};
    for (const x of raw) { const multi = KB.feature[x.f].multi; const k = multi ? x.f + '|' + x.code : x.f; (groups[k] = groups[k] || []).push(x); }
    const out = [];
    for (const k in groups) {
      const g = groups[k], f = KB.feature[g[0].f], from = [...new Set(g.map(x => x.from))];
      if (f.multi) { out.push({ f: f.id, code: g[0].code, status: g.some(x => x.status === 'present') ? 'present' : 'absent', from }); continue; }
      const idx = c => f.values.findIndex(v => v.code === c);
      const worst = g.reduce((a, b) => idx(b.code) > idx(a.code) ? b : a);
      out.push({ f: f.id, code: worst.code, status: 'present', from });
    }
    const ast = values.ast, alt = values.alt;
    if (typeof ast === 'number' && typeof alt === 'number' && KB.feature.ast_alt_pattern) {
      const altUln = ctx && ctx.sex === 'male' ? 42 : 23;
      let code = null;
      if (Math.max(ast, alt) > 1000) code = 'gt1000';
      else if (ast > 30 || alt > altUln) code = alt > ast ? 'alt_dominant' : ast > alt ? 'ast_dominant' : null;
      if (code) out.push({ f: 'ast_alt_pattern', code, status: 'present', from: ['ast', 'alt'] });
    }
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
