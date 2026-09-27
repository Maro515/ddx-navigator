/* 症例問題集での鑑別精度評価
 *   node tools/eval_qbank.js <問題集.md> [--map 対応表.json] [--detail dev|holdout|all] [--json out.json]
 *   AI 抽出で評価: [--llm anthropic|openai] [--model ID] [--limit N] [--conc 4] [--no-cache] [--dry]
 *  各問の症例文 → 抽出（既定はローカル解析、--llm で AI 抽出）→ 鑑別 → 解答疾患の順位。
 *  解答 → 疾患 ID の対応は tests/qbank_answer_map.json（いずれかが上位なら正解）。--map で別の対応表（別版など）。
 *  holdout（q % 3 == 0）は改善の検討に使わず、一般化の見積もりにだけ使う。
 *  AI 抽出のキーは ~/.config/ddx-navigator/{anthropic,openai}_key から読み、表示しない。
 *  AI 抽出の結果は ~/.cache/ddx-navigator/llm にキャッシュする（同じモデル・同じ文なら再課金しない。--no-cache で無効）。
 *  問題集そのものと抽出結果はリポジトリに含めない。 */
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const B = path.join(__dirname, '..', 'build');
for (const f of ['10_kb', '11_kb_abd_ext', '12_evidence', '13_prevalence', '19_labs', '20_state', '30_safety', '40_ddx', '50_next', '60_audit', '65_extract']) require(path.join(B, f + '.js'));
const D = globalThis.DDX, KB = D.KB;
const args = process.argv.slice(2);
const VALUED = ['--detail', '--json', '--map', '--llm', '--model', '--limit', '--conc', '--effort'];
const opt = f => args.includes(f) ? args[args.indexOf(f) + 1] : null;
const flagVals = new Set(VALUED.filter(f => args.includes(f)).map(f => args[args.indexOf(f) + 1]).filter(Boolean));
const src = args.find(a => !a.startsWith('--') && !flagVals.has(a));
if (!src) { console.error('usage: node tools/eval_qbank.js <問題集.md> [--map 対応表] [--detail dev|holdout|all] [--json out] [--llm anthropic|openai --model ID --limit N --conc 4 --no-cache --dry]'); process.exit(1); }
const detail = args.includes('--detail') ? (/^(dev|holdout|all)$/.test(opt('--detail') || '') ? opt('--detail') : 'dev') : '';
const jsonOut = opt('--json');
const mapPath = opt('--map') || path.join(__dirname, '..', 'tests', 'qbank_answer_map.json');
const MAP0 = JSON.parse(fs.readFileSync(mapPath, 'utf8')).map;
// 統合された疾患（疾患群）は統合先の ID で採点する
const ALIAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'disease_alias.json'), 'utf8'));
const canon = x => { const seen = new Set(); while (ALIAS[x] && !seen.has(x)) { seen.add(x); x = ALIAS[x]; } return x; };
const MAP = Object.fromEntries(Object.entries(MAP0).map(([q, ids]) => [q, [...new Set(ids.map(canon))]]));

/* ---- AI 抽出の設定 ---- */
const provider = opt('--llm');
const DEFAULT_MODEL = { anthropic: 'claude-opus-5-5', openai: 'gpt-6-luna' };
const model = opt('--model') || (provider && DEFAULT_MODEL[provider]);
const limit = +(opt('--limit') || 0), conc = Math.max(1, +(opt('--conc') || 4));
const useCache = !args.includes('--no-cache'), dry = args.includes('--dry');
const effort = opt('--effort') || 'low';   // 思考の深さ（low/medium/high）。アプリの既定は low
// 料金（米ドル/100万トークン、2026-09 時点の公表値）。cw = キャッシュ書き込み、cr = キャッシュ読み出し。未登録のモデルは費用を出さない
const PRICE = {
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 }, 'claude-opus-5': { in: 5, out: 25, cw: 6.25, cr: 0.5 },
  'claude-haiku-4-5': { in: 1, out: 5, cw: 1.25, cr: 0.1 }, 'gpt-6-luna': { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01 }
};
let apiKey = null;
if (provider && !dry) {
  const kf = path.join(os.homedir(), '.config', 'ddx-navigator', provider + '_key');
  if (!fs.existsSync(kf)) { console.error(`キーのファイルがありません: ${kf}\nターミナルで次を実行して保存してください（入力は表示されません）:\n  read -s "K?API key: " && printf %s "$K" > ${kf} && chmod 600 ${kf} && unset K`); process.exit(2); }
  apiKey = fs.readFileSync(kf, 'utf8').trim();
  if (!apiKey) { console.error('キーのファイルが空です: ' + kf); process.exit(2); }
}
const cacheDir = path.join(os.homedir(), '.cache', 'ddx-navigator', 'llm');
if (provider && useCache) fs.mkdirSync(cacheDir, { recursive: true });
const promptHash = crypto.createHash('sha1').update(D.Extract.SYSTEM() + JSON.stringify(D.Extract.TOOL())).digest('hex').slice(0, 10);
const stats = { calls: 0, cached: 0, fail: 0, errors: {}, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, latency: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function llmExtract(text) {
  const sc = D.Extract.scrub(text);
  const loc = D.Extract.local(sc.text);
  const key = crypto.createHash('sha1').update([provider, model, promptHash, effort === 'low' ? '' : effort, sc.text].join('\n')).digest('hex');
  const cf = path.join(cacheDir, key + '.json');
  if (useCache && fs.existsSync(cf)) { stats.cached++; return JSON.parse(fs.readFileSync(cf, 'utf8')); }
  let out = null, err = null;
  for (let attempt = 0; attempt < 5 && !out; attempt++) {
    try {
      stats.calls++;
      if (provider === 'anthropic') { D.Extract.LLM.config.apiKey = apiKey; D.Extract.LLM.config.model = model; D.Extract.LLM.config.timeoutMs = 120000; D.Extract.LLM.config.effort = effort; out = await D.Extract.LLM.extract(sc.text); }
      else out = await require('./llm_openai.js')({ apiKey, model, text: sc.text, effort });
    } catch (e) {
      err = e; const m = String(e && e.message || e);
      if (/HTTP (429|500|502|503|504|529)/.test(m) || /abort/i.test(m)) { await sleep(Math.min(60000, (e.retryAfter ? e.retryAfter * 1000 : 0) || 2000 * 2 ** attempt)); continue; }
      break;
    }
  }
  let result;
  if (out) {
    // アプリの extract() と同じ合成: AI の項目＋ローカル解析のバイタル/検査値
    const have = new Set(out.items.map(i => i.feature_id + '|' + (i.value_code || '')));
    for (const it of loc.items) if (['vital', 'lab'].includes(KB.feature[it.feature_id].type) && !have.has(it.feature_id + '|' + (it.value_code || ''))) out.items.push(it);
    result = { ok: true, items: out.items, context: Object.assign({}, loc.context, out.context), usage: out.usage || {}, latency: out.latency };
    const u = out.usage || {};
    for (const k of Object.keys(stats.usage)) stats.usage[k] += u[k] || 0;
    stats.latency.push(out.latency || 0);
    if (useCache) fs.writeFileSync(cf, JSON.stringify(result));
  } else {
    stats.fail++; const m = String(err && err.message || err).slice(0, 80); stats.errors[m] = (stats.errors[m] || 0) + 1;
    result = { ok: false, items: loc.items, context: loc.context, usage: {}, error: m };   // 失敗時はローカル解析で代替（アプリと同じ）
  }
  return result;
}

/* 問題集の読み込み */
const qs = []; let cur = null, sec = null;
for (const ln of fs.readFileSync(src, 'utf8').split('\n')) {
  let m;
  if ((m = ln.match(/^##\s+(.*)/))) { sec = m[1].trim(); continue; }
  if ((m = ln.match(/^\*\*問(\d+)\*\*\s*(.*)/))) { cur = { q: +m[1], sec, text: m[2].trim() }; qs.push(cur); continue; }
  if ((m = ln.match(/^\*\*解答[：:]\s*(.*?)\*\*/)) && cur) { cur.answer = m[1].trim(); cur = null; continue; }
  if (cur && ln.trim() && !cur.answer) cur.text += ln.trim();
}
const targets = limit ? qs.slice(0, limit) : qs;
const clean = q => q.text.replace(/最も考えられる[^。]*?は(何|どれ)か。?/, '').trim();

function score(q, ex) {
  const st = new D.ClinicalState({ context: Object.assign({ setting: 'emergency' }, ex.context) });
  for (const it of ex.items) { try { st.add(it); } catch (e) { /* 未知の項目は無視 */ } }
  const r = D.runSync(st);
  const ranked = r.ddx.ranked;
  const acc = MAP[String(q.q)] || [];
  const ranks = acc.map(id => ranked.indexOf(id) + 1).filter(k => k > 0);
  const rank = acc.length ? (ranks.length ? Math.min(...ranks) : 999) : null;
  // 所見だけ（事前確率を除いた尤度）で並べたときの順位。これが 5 位以内なのに実順位が下なら「有病率のため下位」
  const likRank = (() => { const L = r.ddx.items.filter(x => !x.d.comorbid).map(x => ({ id: x.id, v: x.ev.sum + x.tf.ln })).sort((a, b) => b.v - a.v).map(x => x.id); const k = acc.map(id => L.indexOf(id) + 1).filter(v => v > 0); return k.length ? Math.min(...k) : null; })();
  return { q: q.q, sec: q.sec, answer: q.answer, acc, rank, likRank, holdout: q.q % 3 === 0, top5: ranked.slice(0, 5).map(id => KB.disease[id].label),
    items: ex.items.map(i => i.feature_id + (i.value_code ? ':' + i.value_code : '') + (i.status === 'absent' ? '(なし)' : '')), ctx: ex.context, llmOk: ex.ok };
}

(async () => {
  if (provider && dry) {
    const sysChars = D.Extract.SYSTEM().length, toolChars = JSON.stringify(D.Extract.TOOL()).length;
    const avgQ = targets.reduce((s, q) => s + clean(q).length, 0) / targets.length;
    console.log(`[dry] ${provider} ${model}: 問 ${targets.length}、指示文+候補一覧 ${sysChars} 字、スキーマ ${toolChars} 字、症例文 平均 ${avgQ.toFixed(0)} 字（トークン数は実行時の usage で確認）`);
    return;
  }
  const res = new Array(targets.length);
  if (provider) {
    let next = 0, done = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (next < targets.length) {
        const i = next++; const ex = await llmExtract(clean(targets[i]));
        res[i] = score(targets[i], ex);
        if (++done % 20 === 0) process.stderr.write(`  ${done}/${targets.length}\n`);
      }
    }));
  } else for (let i = 0; i < targets.length; i++) res[i] = score(targets[i], Object.assign({ ok: null }, D.Extract.local(clean(targets[i]))));

  function summary(list, name) {
    const inKB = list.filter(x => x.rank !== null), n = inKB.length;
    const at = k => inKB.filter(x => x.rank <= k).length;
    const pct = k => (at(k) / Math.max(1, n) * 100).toFixed(1) + '%';
    const byPrev = inKB.filter(x => x.rank > 5 && x.likRank && x.likRank <= 5).length;
    console.log(`${name.padEnd(8)} 問 ${String(list.length).padStart(3)}（KB 該当 ${n}） Top1 ${pct(1)}  Top3 ${pct(3)}  Top5 ${pct(5)}  Top10 ${pct(10)}  圏外 ${n - at(10)}  Top5外のうち有病率のため下位 ${byPrev}`);
    return { n: list.length, inKB: n, top1: at(1), top3: at(3), top5: at(5), top10: at(10) };
  }
  console.log(provider ? `抽出: ${provider} / ${model}（思考 ${effort}）` : '抽出: ローカル解析');
  const out = { all: summary(res, '全体'), dev: summary(res.filter(x => !x.holdout), '改善用'), holdout: summary(res.filter(x => x.holdout), '検証用') };
  if (provider) {
    const u = stats.usage, p = PRICE[model];
    // Anthropic の input_tokens はキャッシュ分を含まない。OpenAI の input_tokens はキャッシュ分を含むので差し引く
    const cost = !p ? null : provider === 'openai'
      ? (((u.input_tokens - u.cache_read_input_tokens) * p.in + u.cache_read_input_tokens * p.cr + u.output_tokens * p.out) / 1e6)
      : ((u.input_tokens * p.in + u.output_tokens * p.out + u.cache_creation_input_tokens * p.cw + u.cache_read_input_tokens * p.cr) / 1e6);
    const lat = stats.latency.slice().sort((a, b) => a - b), med = lat.length ? lat[Math.floor(lat.length / 2)] : 0;
    console.log(`AI 呼び出し ${stats.calls} 回（キャッシュ利用 ${stats.cached}、失敗→ローカル代替 ${stats.fail}）、応答時間の中央値 ${(med / 1000).toFixed(1)} 秒`);
    console.log(`トークン: 入力 ${u.input_tokens}、キャッシュ書込 ${u.cache_creation_input_tokens}、キャッシュ読出 ${u.cache_read_input_tokens}、出力 ${u.output_tokens}` + (p ? `、概算費用 $${cost.toFixed(2)}（今回の新規呼び出し分）` : '（料金未登録のモデル）'));
    if (stats.fail) console.log('失敗の内訳: ' + JSON.stringify(stats.errors));
  }
  if (detail) {
    const show = res.filter(x => x.rank !== null && x.rank > 5 && (detail === 'all' || (detail === 'holdout') === x.holdout));
    console.log(`\n--- Top5 外（${detail}）${show.length} 問 ---`);
    for (const x of show.sort((a, b) => a.q - b.q)) console.log(`問${x.q} [${x.rank === 999 ? '除外' : x.rank + '位'}${x.likRank && x.likRank <= 5 ? '・所見だけなら' + x.likRank + '位（有病率のため下位）' : ''}] ${x.answer}${x.llmOk === false ? '（AI 失敗→ローカル）' : ''}\n   上位: ${x.top5.join(' / ')}\n   抽出: ${x.items.join(', ') || '（なし）'} ${JSON.stringify(x.ctx)}`);
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary: out, provider, model, effort, stats, results: res }, null, 1));
})();
