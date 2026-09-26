/* ============================================================
 * Audit / Registry — 版固定・入出力ログ（localStorage、改変UIなし）
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  DDX.ENGINE_VERSION = '0.1.0';
  const KEY = 'ddxnav_audit_v1';
  const MAX = 300;
  const store = () => { try { return g.localStorage; } catch (e) { return null; } };
  let mem = [];
  function load() { const s = store(); if (!s) return mem; try { return JSON.parse(s.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function save(list) { const s = store(); if (!s) { mem = list; return; } try { s.setItem(KEY, JSON.stringify(list)); } catch (e) { } }
  const Audit = {
    versions() { return { engine_version: DDX.ENGINE_VERSION, kb_version: DDX.KB.version, rule_version: DDX.KB.rulesVersion, jev_adapter: DDX.Jev ? DDX.Jev.version : null, jev_provider: DDX.Jev ? DDX.Jev.config.provider : 'none' }; },
    log(entry) {
      const list = load();
      list.push(Object.assign({ ts: Date.now(), versions: Audit.versions() }, entry));
      while (list.length > MAX) list.shift();
      save(list);
      return list[list.length - 1];
    },
    list() { return load(); },
    clear() { save([]); },
    export() { return JSON.stringify({ exported_at: new Date().toISOString(), versions: Audit.versions(), entries: load() }, null, 2); }
  };
  DDX.Audit = Audit;

  /* 一括更新パイプライン（API更新フロー 1→8） */
  DDX.run = async function (state, opts) {
    opts = opts || {};
    const safety = DDX.Safety.evaluate(state);
    const ddx = DDX.Differential.compute(state, safety);
    let jev = null;
    if (opts.jev !== false && DDX.Jev.config.provider !== 'none') {
      const pre = DDX.NextItem.compute(state, ddx, safety, {});
      jev = await DDX.Jev.evaluate(state, ddx, pre.all);
    }
    const next = DDX.NextItem.compute(state, ddx, safety, { jev });
    const out = { safety, ddx, next, state_hash: state.hash(), computed_at: Date.now() };
    if (!opts.noLog) DDX.Audit.log({
      case_token: state.case_token, state_hash: out.state_hash, n_obs: ddx.nObs,
      top10: ddx.likely.filter(x => !x.comorbid).map(x => x.id), mnm_alert: ddx.mnm.filter(m => m.status === 'alert').map(m => m.id),
      next5: next.top.map(x => x.feature_id), forced: next.forced.map(x => x.feature_id),
      safety_alerts: safety.alerts.map(a => a.id), scope: safety.scope.status, contradictions: safety.contradictions.map(c => c.id),
      jev: next.jev, action: opts.action || 'update'
    });
    return out;
  };
  DDX.runSync = function (state) {
    const safety = DDX.Safety.evaluate(state);
    const ddx = DDX.Differential.compute(state, safety);
    const next = DDX.NextItem.compute(state, ddx, safety, {});
    return { safety, ddx, next, state_hash: state.hash() };
  };
})(typeof window !== 'undefined' ? window : globalThis);
