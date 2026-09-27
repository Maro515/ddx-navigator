#!/usr/bin/env python3
"""tools/prevalence.json（有病率の概算）から build/13_prevalence.js を生成する。
   拡張疾患の事前確率を「腹部症状を伴う受診発症数（10万人年）× k」で置き換え、全疾患に頻度区分を付ける。"""
import json, os, subprocess
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = json.load(open(os.path.join(BASE, 'tools', 'prevalence.json'), encoding='utf-8'))
ids = json.loads(subprocess.check_output(['node', '-e', "require('./build/10_kb.js');require('./build/11_kb_abd_ext.js');console.log(JSON.stringify(globalThis.DDX.KB.diseases.map(d=>[d.id,!!d.ext])))"], cwd=BASE))
missing = [i for i, ext in ids if ext and i not in P['inc'] and i not in P['fixed']]
unknown = [i for i in list(P['inc']) + list(P['fixed']) if i not in {x for x, _ in ids}]
if missing: print('WARN 有病率が未設定の拡張疾患:', missing)
if unknown: print('WARN KB に無い疾患:', unknown)
js = lambda o: json.dumps(o, ensure_ascii=False)
out = f"""/* ============================================================
 * 有病率（事前確率）— 自動生成: tools/build_prevalence.py ← tools/prevalence.json
 *  拡張疾患: prior = 腹部症状を伴う受診発症数（日本・10万人年の概算）× k。コア疾患は 10_kb.js の値のまま
 *  値は臨床疫学に基づく概算で、一次文献での裏付けは未了。
 * ============================================================ */
(function (g) {{
  const KB = g.DDX.KB;
  const K = {P['k']}, FLOOR = {P['floor']};
  const INC = {js(P['inc'])};
  const FIXED = {js(P['fixed'])};
  KB.prevalenceScale = {{ k: K, unit: '腹部症状を伴う受診発症数/10万人年（概算）' }};
  KB.prevalence = {{}};
  for (const d of KB.diseases) {{
    if (FIXED[d.id] !== undefined) {{ d.prior = FIXED[d.id]; KB.prevalence[d.id] = {{ inc: null, src: 'fixed' }}; }}
    else if (INC[d.id] !== undefined) {{ d.prior = Math.max(FLOOR, INC[d.id] * K); KB.prevalence[d.id] = {{ inc: INC[d.id], src: 'estimate' }}; }}
    else KB.prevalence[d.id] = {{ inc: d.prior / K, src: d.ext ? 'draft' : 'core' }};
  }}
  /* 頻度区分（画面表示用）: 受診発症数/10万人年 */
  KB.prevalenceTier = function (id) {{
    const pv = KB.prevalence[id]; if (!pv) return null;
    const inc = pv.inc === null ? KB.disease[id].prior / K : pv.inc;
    return inc >= 30 ? '多い' : inc >= 10 ? 'やや多い' : inc >= 1 ? '少ない' : inc >= 0.1 ? 'まれ' : '非常にまれ';
  }};
}})(typeof window !== 'undefined' ? window : globalThis);
"""
open(os.path.join(BASE, 'build', '13_prevalence.js'), 'w', encoding='utf-8').write(out)
print('build/13_prevalence.js:', len(P['inc']), 'estimates +', len(P['fixed']), 'fixed')
