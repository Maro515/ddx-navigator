/* OpenAI Responses API で同じ抽出を行う（評価用。アプリ本体には未組み込み）。
 *  指示文・出力スキーマはアプリと同一（DDX.Extract.SYSTEM / TOOL）。結果は DDX.Extract.validate で同じ検証にかける。
 *  store:false で応答をサーバーに保存させない。reasoning.effort は受け付けられなければ外して再試行する。 */
module.exports = async function extractOpenAI({ apiKey, model, text, timeoutMs = 90000, effort = 'low' }) {
  const D = globalThis.DDX, tool = D.Extract.TOOL();
  const body = {
    model, store: false,
    instructions: D.Extract.SYSTEM(),
    input: [{ role: 'user', content: D.Extract.USER(text) }],
    tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: true }],
    tool_choice: { type: 'function', name: tool.name }
  };
  if (effort) body.reasoning = { effort };
  const call = async b => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey }, body: JSON.stringify(b) });
      const j = await res.json().catch(() => ({}));
      return { status: res.status, j, retryAfter: +res.headers.get('retry-after') || 0 };
    } finally { clearTimeout(timer); }
  };
  const t0 = Date.now();
  let r = await call(body);
  if (r.status === 400 && body.reasoning && /reasoning|effort/i.test(JSON.stringify(r.j.error || ''))) { delete body.reasoning; r = await call(body); }
  if (r.status !== 200) { const e = new Error('HTTP ' + r.status + ': ' + ((r.j.error && r.j.error.message) || '')); e.status = r.status; e.retryAfter = r.retryAfter; throw e; }
  const fc = (r.j.output || []).find(o => o.type === 'function_call' && o.name === tool.name);
  if (!fc) throw new Error('構造化出力が返りませんでした（output: ' + (r.j.output || []).map(o => o.type).join(',') + '）');
  const out = D.Extract.validate(JSON.parse(fc.arguments));
  const u = r.j.usage || {};
  const usage = { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
    cache_read_input_tokens: (u.input_tokens_details && u.input_tokens_details.cached_tokens) || u.cache_read_input_tokens || 0,
    reasoning_tokens: (u.output_tokens_details && u.output_tokens_details.reasoning_tokens) || 0, raw_keys: Object.keys(u) };
  return Object.assign(out, { ok: true, provider: 'openai', model: r.j.model || model, latency: Date.now() - t0, usage });
};
