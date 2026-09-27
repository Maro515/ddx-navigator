/* 症例問題集での鑑別精度評価: node tools/eval_qbank.js <問題集.md> [--detail dev|holdout|all] [--json out.json]
 *  各問の症例文 → ローカル抽出（AI なし）→ 鑑別 → 解答疾患の順位。
 *  解答 → 疾患 ID の対応は tests/qbank_answer_map.json（いずれかが上位なら正解）。
 *  holdout（q % 3 == 0）は改善の検討に使わず、一般化の見積もりにだけ使う。
 *  問題集そのものはリポジトリに含めない。 */
const fs = require('fs'), path = require('path');
const B = path.join(__dirname, '..', 'build');
for (const f of ['10_kb', '11_kb_abd_ext', '12_evidence', '13_prevalence', '19_labs', '20_state', '30_safety', '40_ddx', '50_next', '60_audit', '65_extract']) require(path.join(B, f + '.js'));
const D = globalThis.DDX, KB = D.KB;
const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith('--'));
if (!src) { console.error('usage: node tools/eval_qbank.js <問題集.md> [--detail dev|holdout|all] [--json out.json]'); process.exit(1); }
const detail = args.includes('--detail') ? (/^(dev|holdout|all)$/.test(args[args.indexOf('--detail') + 1] || '') ? args[args.indexOf('--detail') + 1] : 'dev') : '';
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'qbank_answer_map.json'), 'utf8')).map;

/* 問題集の読み込み */
const qs = []; let cur = null, sec = null;
for (const ln of fs.readFileSync(src, 'utf8').split('\n')) {
  let m;
  if ((m = ln.match(/^##\s+(.*)/))) { sec = m[1].trim(); continue; }
  if ((m = ln.match(/^\*\*問(\d+)\*\*\s*(.*)/))) { cur = { q: +m[1], sec, text: m[2].trim() }; qs.push(cur); continue; }
  if ((m = ln.match(/^\*\*解答[：:]\s*(.*?)\*\*/)) && cur) { cur.answer = m[1].trim(); cur = null; continue; }
  if (cur && ln.trim() && !cur.answer) cur.text += ln.trim();
}

function evalQ(q) {
  const text = q.text.replace(/最も考えられる(疾患|病態|診断)(名)?は(何|どれ)か。?/, '').trim();
  const ex = D.Extract.local(text);
  const st = new D.ClinicalState({ context: Object.assign({ setting: 'emergency' }, ex.context) });
  for (const it of ex.items) st.add(it);
  const r = D.runSync(st);
  const ranked = r.ddx.ranked;
  const acc = MAP[String(q.q)] || [];
  const ranks = acc.map(id => ranked.indexOf(id) + 1).filter(k => k > 0);
  const rank = acc.length ? (ranks.length ? Math.min(...ranks) : 999) : null;
  // 所見だけ（事前確率を除いた尤度）で並べたときの順位。これが 5 位以内なのに実順位が下なら「有病率のため下位」
  const likRank = (() => { const L = r.ddx.items.filter(x => !x.d.comorbid).map(x => ({ id: x.id, v: x.ev.sum + x.tf.ln })).sort((a, b) => b.v - a.v).map(x => x.id); const k = acc.map(id => L.indexOf(id) + 1).filter(v => v > 0); return k.length ? Math.min(...k) : null; })();
  return { q: q.q, sec: q.sec, answer: q.answer, acc, rank, likRank, holdout: q.q % 3 === 0, top5: ranked.slice(0, 5).map(id => KB.disease[id].label),
    items: ex.items.map(i => i.feature_id + (i.value_code ? ':' + i.value_code : '') + (i.status === 'absent' ? '(なし)' : '')), ctx: ex.context };
}
const res = qs.map(evalQ);
function summary(list, name) {
  const inKB = list.filter(x => x.rank !== null), n = inKB.length;
  const at = k => inKB.filter(x => x.rank <= k).length;
  const pct = k => (at(k) / Math.max(1, n) * 100).toFixed(1) + '%';
  const byPrev = inKB.filter(x => x.rank > 5 && x.likRank && x.likRank <= 5).length;
  console.log(`${name.padEnd(8)} 問 ${String(list.length).padStart(3)}（KB 該当 ${n}） Top1 ${pct(1)}  Top3 ${pct(3)}  Top5 ${pct(5)}  Top10 ${pct(10)}  圏外 ${n - at(10)}  Top5外のうち有病率のため下位 ${byPrev}`);
  return { n: list.length, inKB: n, top1: at(1), top3: at(3), top5: at(5), top10: at(10) };
}
const out = { all: summary(res, '全体'), dev: summary(res.filter(x => !x.holdout), '改善用'), holdout: summary(res.filter(x => x.holdout), '検証用') };
if (detail) {
  const show = res.filter(x => x.rank !== null && x.rank > 5 && (detail === 'all' || (detail === 'holdout') === x.holdout));
  console.log(`\n--- Top5 外（${detail}）${show.length} 問 ---`);
  for (const x of show.sort((a, b) => a.q - b.q)) console.log(`問${x.q} [${x.rank === 999 ? '除外' : x.rank + '位'}${x.likRank && x.likRank <= 5 ? '・所見だけなら' + x.likRank + '位（有病率のため下位）' : ''}] ${x.answer}\n   上位: ${x.top5.join(' / ')}\n   抽出: ${x.items.join(', ') || '（なし）'} ${JSON.stringify(x.ctx)}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary: out, results: res }, null, 1));
