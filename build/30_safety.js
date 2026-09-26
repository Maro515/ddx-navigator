/* ============================================================
 * Safety Engine — 緊急条件・適用外・前提・矛盾を Jev/LLM より先にコードで判定
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;

  function ageIdx(b) { const i = KB().ageIndex[b]; return (i === undefined) ? null : i; }

  function evalCond(c, state) {
    if (!c) return false;
    if (c.all) return c.all.every(x => evalCond(x, state));
    if (c.any) return c.any.some(x => evalCond(x, state));
    if (c.count2) return c.count2.filter(x => evalCond(x, state)).length >= 2;
    if (c.ctx) {
      const v = state.context[c.ctx];
      if (c.ctx === 'age_max') { const a = ageIdx(state.context.age_band); return a !== null && a <= ageIdx(c.is); }
      if (c.ctx === 'age_min') { const a = ageIdx(state.context.age_band); return a !== null && a >= ageIdx(c.is); }
      if (c.ctx === 'pregnancy_not') { const p = state.context.pregnancy; return p !== c.is; }
      return v === c.is;
    }
    if (c.f) {
      if (c.unobserved) return !state.isObserved(c.f) && !state.isPending(c.f) && !state.isNotAssessable(c.f);
      if (c.present) return state.has(c.f, null);
      if (c.absent) return state.isAbsent(c.f);
      if (c.in) return state.has(c.f, c.in);
    }
    return false;
  }

  function evaluate(state) {
    const kb = KB();
    const alerts = [], contradictions = [], forced = [], forcedReason = {};
    let scope = { status: 'in_scope', messages: [] };
    for (const r of kb.scopeRules) if (evalCond(r.when, state)) {
      if (r.status === 'out_of_scope') scope.status = 'out_of_scope'; else if (scope.status !== 'out_of_scope') scope.status = 'special_path';
      scope.messages.push(r.message);
    }
    for (const r of kb.safetyRules) if (evalCond(r.when, state)) {
      alerts.push({ id: r.id, level: r.level, label: r.label, message: r.message, force_next: r.force_next });
      for (const f of r.force_next || []) if (!state.isObserved(f) && !state.isPending(f) && !state.isNotAssessable(f)) { if (!forced.includes(f)) forced.push(f); (forcedReason[f] = forcedReason[f] || []).push(r.label); }
    }
    for (const r of kb.prerequisiteRules) if (evalCond(r.when, state)) {
      for (const f of r.force_next || []) if (!state.isObserved(f) && !state.isPending(f) && !state.isNotAssessable(f)) { if (!forced.includes(f)) forced.push(f); (forcedReason[f] = forcedReason[f] || []).push(r.label); }
    }
    for (const r of kb.contradictionRules) if (evalCond(r.when, state)) contradictions.push({ id: r.id, message: r.message });
    // 古い重要情報の再確認（バイタル/乳酸）
    const stale = state.current().filter(o => state.isStale(o) && (o.feature_type === 'vital' || o.feature_id === 'lactate'));
    const order = { emergent: 0, path: 1, warning: 2 };
    alerts.sort((a, b) => order[a.level] - order[b.level]);
    return {
      alerts, scope, contradictions, forced, forcedReason, stale: stale.map(o => o.feature_id),
      emergent: alerts.some(a => a.level === 'emergent'),
      rules_version: kb.rulesVersion
    };
  }
  DDX.Safety = { evaluate, evalCond };
})(typeof window !== 'undefined' ? window : globalThis);
