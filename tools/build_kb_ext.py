#!/usr/bin/env python3
"""エージェントが抽出した疾患カタログ JSON（scratchpad/ext_*.json）から build/11_kb_abd_ext.js を生成する。
   値はすべてドラフト（三次資料の頻度語 → 感度の近似）。本文は含めない（疾患名・所見対応・章題のみ）。"""
import json, glob, re, sys, os
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else '/private/tmp/claude-501/-Users-maro515-Applications/4eae881f-dee0-48da-a910-51eeb6ea7984/scratchpad'
OUT = os.path.join(BASE, 'build', '11_kb_abd_ext.js')

import subprocess
kb = json.loads(subprocess.check_output(['node', '-e', """require('./build/10_kb.js');const K=globalThis.DDX.KB;console.log(JSON.stringify({d:K.diseases.map(d=>({id:d.id,label:d.label})),f:K.features.map(f=>({id:f.id,label:f.label,type:f.type,base:f.base,values:(f.values||[]).map(v=>v.code)}))}))"""], cwd=BASE))
KD = {d['id']: d for d in kb['d']}; KDL = {d['label']: d['id'] for d in kb['d']}
KF = {f['id']: f for f in kb['f']}
ALIAS = json.load(open(os.path.join(BASE, 'tools', 'disease_alias.json'))) if os.path.exists(os.path.join(BASE, 'tools', 'disease_alias.json')) else {}
# 異なる所見を1項目にまとめた値付き項目は複数選択（値ごとに最新を保持）
MULTI = {'neuro_sx','skin_finding','electrolyte','ct_other','ct_wall_mass','endoscopy','hb_imaging','chronic_liver_labs','drug_hx_colitis','drug_hx_metabolic','anal_sx','abd_mass','endocrine_lab','autoantibodies','hepatitis_serology','cxr','urine_stool_color','diarrhea_pattern','hemolysis_labs','sx_sequence'}
FALIAS = json.load(open(os.path.join(BASE, 'tools', 'feature_alias.json'))) if os.path.exists(os.path.join(BASE, 'tools', 'feature_alias.json')) else {}
FDEFS = json.load(open(os.path.join(BASE, 'tools', 'feature_defs.json'), encoding='utf-8')) if os.path.exists(os.path.join(BASE, 'tools', 'feature_defs.json')) else {}
FDEF_F = FDEFS.get('features', {})
MULTI |= {fid for fid, d in FDEF_F.items() if d.get('multi')}

def alias_specs(fid):
    a = FALIAS.get(fid)
    if not a: return None
    return a['expand'] if 'expand' in a else [a]

def alias_targets(fid, vals):
    """1つの所見 → [(to, vals, sens_override, spec_override)]。
       values マップ: 値→値 / 値→[値…]（分割）/ '=' 恒等 / '@feature'（別項目へ）/ null（関係ごと捨てる）/ 未記載は '*' か DROP"""
    specs = alias_specs(fid)
    if specs is None: return [(fid, vals, None, None)]
    out = []
    for sp in specs:
        to = sp.get('to', fid); vm = sp.get('values'); so, po = sp.get('sens'), sp.get('spec')
        if vm is None: out.append((to, vals, so, po)); continue
        if vals:
            res, kill = [], False
            for v in vals:
                t = vm[v] if v in vm else vm.get('*', 'DROP')
                if t is None: kill = True; break
                if t == 'DROP': continue
                if t == '=': t = v
                for x in (t if isinstance(t, list) else [t]):
                    if x not in res: res.append(x)
            if kill or not res: continue
            out.append((to, res, so, po))
        else:
            star = vm.get('*')
            if star and star != '=': out.append((to, star if isinstance(star, list) else [star], so, po))
            else: out.append((to, None, so, po))
    return out

def self_value_map(fid):
    """統合元が自分自身に残る場合の値マップ（新規項目の値集合を作るため）"""
    for sp in (alias_specs(fid) or []):
        if sp.get('to', fid) == fid: return sp.get('values')
    return None

SENS = {'high': 0.80, 'mid': 0.50, 'low': 0.20}
PRIOR = {'common': 0.03, 'uncommon': 0.008, 'rare': 0.002}
TYPE_CAT = {'chief_complaint': 'cc', 'symptom': 'cc', 'history': 'hx', 'exam': 'exam', 'vital': 'vital', 'lab': 'lab', 'imaging': 'img'}
ANCHOR = {'chief_complaint': 'onset', 'symptom': 'onset', 'history': 'history', 'exam': 'observation', 'vital': 'observation', 'lab': 'collection', 'imaging': 'imaging'}
ACQ = {'lab': "{ cost: 1, inv: 1, delay: 2, stage: 'lab' }", 'imaging': "{ cost: 2, inv: 1, delay: 2, stage: 'imaging' }"}

items = []
for p in sorted(glob.glob(os.path.join(SRC, 'ext_*.json'))):
    arr = json.load(open(p, encoding='utf-8'))
    items.extend(arr)
print('loaded', len(items), 'entries')

def js(s): return json.dumps(s, ensure_ascii=False)
new_features, new_values, diseases, relations, refs = {}, [], {}, [], {}
skipped = []
def norm_id(x):
    x = re.sub(r'[^a-z0-9_]+', '_', x.lower()).strip('_')
    return ALIAS.get(x, x)
def norm_fid(x):
    return re.sub(r'[^a-z0-9_]+', '_', x.replace('NEW:', '').lower()).strip('_')
for it in items:
    did = norm_id(it['id'])
    if it.get('name_ja') in KDL: did = KDL[it['name_ja']]
    if did in KD: it['_existing'] = True
    for nf in it.get('new_features', []) or []:
        fid = norm_fid(nf['id'])
        if fid in KF: continue
        specs = alias_specs(fid)
        if specs is not None and not any(sp.get('to', fid) == fid for sp in specs): continue  # 他項目へ統合済み
        vals = nf.get('values') or []
        vm = self_value_map(fid)
        if vm:  # 同一 feature 内の値エイリアス → 正規値のみ
            mapped = []
            for c, l in vals:
                t = vm[c] if c in vm else vm.get('*', 'DROP')
                if t in (None, 'DROP') or (isinstance(t, str) and t.startswith('@')): continue
                if t == '=': t = c
                if isinstance(t, str): mapped.append([t, l])
            vals = mapped
        if fid not in new_features: new_features[fid] = dict(nf); new_features[fid]['id'] = fid; new_features[fid]['values'] = list(vals) or None
        else:
            cur = new_features[fid].get('values') or []
            have = {c for c, l in cur}
            for c, l in vals:
                if c not in have: cur.append([c, l]); have.add(c)
            new_features[fid]['values'] = cur or None
    key = did
    if key in diseases:  # merge findings
        diseases[key]['findings'].extend(it.get('findings', []))
        diseases[key].setdefault('source_files', []).extend(it.get('source_files', []))
        continue
    it['_id'] = did; diseases[key] = it

lines = ["/* ============================================================",
         " * 腹部症状 拡張パック（自動生成: tools/build_kb_ext.py）",
         " *  出典: 今日の臨床サポート 各章の鑑別表を参照して疾患と所見の対応を作成（本文は含まない）。",
         " *  感度/特異度は頻度語からの近似ドラフト。根拠台帳の一次文献で順次置換する。",
         " * ============================================================ */",
         "(function (g) {", "  const KB = g.DDX.KB;", "  const P = KB.packs;"]
# 項目定義の上書き（ラベル・値・型）と、資料に無い新規項目（CK/LD/sIL-2R/ICI など）
for fid, d in FDEF_F.items():
    if fid in KF and fid not in new_features: continue
    base_nf = new_features.get(fid, {'id': fid, 'type': d.get('type', 'symptom')})
    base_nf = dict(base_nf); base_nf.update({k: v for k, v in d.items() if k in ('label', 'type', 'values', 'base')})
    new_features[fid] = base_nf
# features
for fid, nf in new_features.items():
    t = nf.get('type', 'symptom'); cat = TYPE_CAT.get(t, 'cc')
    vals = nf.get('values')
    vals_js = ('[' + ', '.join(f"['{c}', {js(l)}]" for c, l in vals) + ']') if vals else 'null'
    acq = ACQ.get(t, "{ cost: 0, inv: 0, delay: 0, stage: 'bedside' }")
    multi = ', multi: true' if fid in MULTI and vals_js != 'null' else ''
    fbase = nf.get('base', 0.1)
    lines.append(f"  KB.addFeature({{ id: '{fid}', label: {js(nf['label'])}, type: '{t}', cat: '{cat}', anchor: '{ANCHOR.get(t, 'observation')}', values: {vals_js}{multi}, acq: {acq}, base: {fbase}, mgmt: 1, ext: true }});")
    KF[fid] = {'id': fid, 'label': nf['label'], 'type': t, 'base': fbase, 'values': [c for c, l in (vals or [])]}
# 既存項目（コアの腹部CT など）への値追加
for fid, vals in FDEFS.get('add_values', {}).items():
    for c, l in vals:
        lines.append(f"  KB.addValue('{fid}', '{c}', {js(l)});")
        if c not in KF[fid]['values']: KF[fid]['values'].append(c)
DROP_REL = {(x['d'], x['f']) for x in FDEFS.get('drop_relations', [])}
# diseases + relations
n_new = 0; n_rel = 0; unknown_feat = {}
for key, it in diseases.items():
    did = it['_id']
    # まず relation 候補を組み立てる
    rels = []; seen = set()
    for f in it.get('findings', []) or []:
        fid0 = norm_fid(f['feature']); vals0 = f.get('values') or None
        sup = f.get('direction', 'supports') == 'supports'
        for fid, vals, s_o, p_o in alias_targets(fid0, vals0):
            if vals and any(str(v).startswith('@') for v in vals):
                for v in [x for x in vals if str(x).startswith('@')]:
                    tgt = v[1:]
                    if tgt in KF and (tgt, ()) not in seen: seen.add((tgt, ())); rels.append({'fid': tgt, 'vals': None, 'sens': SENS.get(f.get('freq', 'mid'), 0.5), 'spec': max(0.55, min(0.95, 1 - (KF[tgt].get('base') or 0.15))), 'type': KF[tgt]['type'], 'key': False})
                vals = [x for x in vals if not str(x).startswith('@')] or None
                if not vals: continue
            if fid not in KF: unknown_feat[fid] = unknown_feat.get(fid, 0) + 1; continue
            if (did, fid) in DROP_REL: continue
            fdef = KF[fid]
            if vals:
                vals = [v for v in vals if v in fdef['values']]
                if not vals: continue
            elif fdef['values'] and fdef['type'] in ('lab', 'imaging', 'vital'):
                continue  # 値集合を持つ検査/画像/バイタルは値指定が必要
            k = (fid, tuple(vals or []))
            if k in seen: continue
            seen.add(k)
            sens = SENS.get(f.get('freq', 'mid'), 0.5) if sup else 0.05
            base = fdef.get('base', 0.15) or 0.15
            spec = 0.85 if vals else max(0.55, min(0.95, 1 - base))
            if not sup: spec = max(0.55, min(0.9, 1 - base))
            if sup and s_o is not None: sens = s_o
            if sup and p_o is not None: spec = p_o
            rels.append({'fid': fid, 'vals': vals, 'sens': sens, 'spec': spec, 'type': fdef['type'], 'key': False})
    clear = []
    if not it.get('_existing'):
        tempo = it.get('tempo') or {}
        onset = {k: max(0.05, float(tempo.get(k, 0) or 0)) for k in ['minutes', 'hours', 'days', 'weeks', 'months']}
        if max(onset.values()) <= 0.05: onset = {k: 1 for k in onset}
        onset['unknown'] = 0.7
        req = {}; mult = []
        # 性別: 解剖学的に性別限定の疾患だけ hard requirement。それ以外の「男性に多い」等は事前確率 ×1.5 の soft
        sex_hard = it.get('category') == '婦人科' or re.search(r'子宮|卵巣|卵管|妊娠|月経|膣|外陰|精巣|睾丸|陰嚢|前立腺|陰茎|産褥|排卵|黄体', it['name_ja'])
        if it.get('sex') in ('female', 'male'):
            if sex_hard: req['sex'] = it['sex']
            else: mult.append({'when': {'sex': it['sex']}, 'x': 1.5})
        if re.search(r'妊娠中|胎盤|子宮破裂|HELLP|AFLP|悪阻|産褥|円靱帯', it['name_ja']) and not re.search(r'異所性|子宮外', it['name_ja']): req['sex'] = 'female'; req['pregnancy_in'] = ['confirmed']
        urg = it.get('urgency', 'routine'); mnm = bool(it.get('mnm'))
        prior = PRIOR.get(it.get('prevalence', 'rare'), 0.002)
        if mnm:
            for r in rels:
                if r['sens'] >= 0.8 and r['type'] in ('lab', 'imaging', 'exam') and len(clear) < 4: r['key'] = True; clear.append(r['fid'])
            clear = list(dict.fromkeys(clear))
        lines.append(f"  KB.addDisease('{did}', {js(it['name_ja'])}, {{ urgency: '{urg}', mnm: {'true' if mnm else 'false'}, prior: {prior}, onset: {js(onset)}, requires: {js(req)}, mult: {js(mult)}, clear: {js(clear)}, category: {js(it.get('category', ''))}, note: {js(it.get('discriminators', ''))}, ext: true }});")
        n_new += 1
    refs[did] = sorted(set(it.get('source_files', []) or []))
    for r in rels:
        lines.append(f"  KB.addRelation('{did}', '{r['fid']}', {js(r['vals'])}, {r['sens']:.2f}, {r['spec']:.2f}{', { key: true }' if r['key'] else ''});")
        n_rel += 1
for r in FDEFS.get('add_relations', []):
    if r['d'] not in KD and r['d'] not in {it['_id'] for it in diseases.values()}: print('add_relations: unknown disease', r['d']); continue
    if r['f'] not in KF: print('add_relations: unknown feature', r['f']); continue
    lines.append(f"  KB.addRelation('{r['d']}', '{r['f']}', {js(r.get('values'))}, {r['sens']:.2f}, {r['spec']:.2f});"); n_rel += 1
lines.append("  KB.reindex();")
lines.append(f"  KB.tertiaryRefs = {js(refs)};")
lines.append("  P.push({ id: 'abd_ext', label: '腹部症状 拡張パック', version: '0.1.0', source: '今日の臨床サポート（参照のみ・ドラフト値）' });")
lines.append("})(typeof window !== 'undefined' ? window : globalThis);")
open(OUT, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print(f'new diseases {n_new}, relations {n_rel}, new features {len(new_features)}')
if unknown_feat: print('unknown features (dropped):', sorted(unknown_feat.items(), key=lambda x: -x[1])[:40])
