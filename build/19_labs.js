/* ============================================================
 * 検査値パネル — 救急で測る血算＋生化学の一覧。数値 → KB の値コードへ（閾値はコード側で判定）
 *  単位・基準値: 国立がん研究センター中央病院 臨床検査科「検査基準値一覧」
 *   https://www.ncc.go.jp/jp/ncch/division/clinical_laboratory/kensa.pdf（2026-09-26 参照）
 *  Hb の低下閾値はオーナー指定（男 <13 / 女 <12）。乳酸・NT-proBNP は同表に無く一般的単位。
 *  map: null の項目は KB に対応 feature が無く、テキストとして入力欄に残す
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
        L('plt', 'Plt', '10⁴/μL', null, { hint: '基準 15.8～34.8（記録のみ）' })
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
        L('na', 'Na', 'mmol/L', null, { hint: '基準 138～145（記録のみ）' }), L('k', 'K', 'mmol/L', null, { hint: '基準 3.6～4.8（記録のみ）' }), L('cl', 'Cl', 'mmol/L', null, { hint: '基準 101～108（記録のみ）' }),
        L('ca', 'Ca', 'mg/dL', null, { hint: '基準 8.8～10.1（記録のみ）' }), L('p', 'P（無機リン）', 'mg/dL', null, { hint: '基準 2.7～4.6（記録のみ）' }), L('mg', 'Mg', 'mg/dL', null, { hint: '基準 1.8～2.4（記録のみ）' }),
        L('glu', '血糖', 'mg/dL', v => ({ f: 'glucose', code: v > 250 ? 'gt250' : 'normal' }), { hint: '基準 73～109（血清）。>250 で高血糖' }),
        L('lac', '乳酸', 'mmol/L', v => ({ f: 'lactate', code: v < 2 ? 'lt2' : v <= 4 ? '2_4' : 'gt4' }), { hint: '区分 2 / 4' }),
        L('ck', 'CK', 'U/L', null, { hint: '基準 男 59～248 / 女 41～153（記録のみ）' }), L('ckmb', 'CK-MB', 'ng/mL', null, { hint: '基準 3.6 以下（記録のみ）' }),
        L('ldh', 'LD', 'U/L', null, { hint: '基準 124～222（記録のみ）' }),
        L('ddimer', 'D-dimer', 'μg/mL', v => ({ f: 'ddimer', code: v >= 1.0 ? 'elevated' : 'normal' }), { hint: '基準 1.0 未満' }),
        L('tni', 'トロポニンI', 'ng/mL', v => ({ f: 'troponin', code: v > 0.03 ? 'pos' : 'neg' }), { hint: '基準 0.03 以下（施設の hs 法では要調整）' }),
        L('bnp', 'BNP', 'pg/mL', null, { hint: '基準 18.4 以下（記録のみ）' }), L('ntprobnp', 'NT-proBNP', 'pg/mL', null, { hint: '記録のみ' }),
        L('nh3', 'アンモニア', 'μg/dL', null, { hint: '基準 12～66（記録のみ）' })
      ] },
      { label: '尿検査（一般）', items: [
        L('ua', '尿定性', '', null, { choice: [['normal', '正常（潜血− 白血球−）'], ['pyuria', '膿尿（白血球エステラーゼ＋）'], ['hematuria', '血尿（潜血＋）'], ['both', '膿尿＋血尿']], f: 'urinalysis' })
      ] }
    ],
    byId: {}
  };
  for (const gr of DDX.LABS.groups) for (const it of gr.items) DDX.LABS.byId[it.id] = it;
})(typeof window !== 'undefined' ? window : globalThis);
