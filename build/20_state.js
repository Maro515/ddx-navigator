/* ============================================================
 * Clinical State Engine — 観測値・欠損・時系列・履歴を一元管理
 *  入力順に依存しない正規化: 同一 feature（非multi）は「最も新しい時間」の観測を current とする
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;
  let seq = 0;

  function token() { return 'c-' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6); }

  class ClinicalState {
    constructor(init) {
      this.case_token = (init && init.case_token) || token();
      this.context = Object.assign({ age_band: null, sex: null, setting: 'emergency', pregnancy: 'unknown', trauma: 'no' }, init && init.context);
      this.observations = []; // all, including superseded
      this.deferred = {};     // feature_id -> true (「後で」)
      this.created_at = (init && init.created_at) || Date.now();
      if (init && init.observations) for (const o of init.observations) this.add(o, true);
      if (init && init.deferred) this.deferred = Object.assign({}, init.deferred);
    }
    static normalize(o) {
      const f = KB().feature[o.feature_id];
      if (!f) throw new Error('unknown feature: ' + o.feature_id);
      const tc = o.time_context || {};
      const obs = {
        obs_id: o.obs_id || ('o' + (++seq) + '-' + Math.random().toString(36).slice(2, 6)),
        feature_id: f.id,
        feature_type: f.type,
        value_code: o.value_code || null,
        status: o.status || (o.value_code ? 'present' : 'present'),
        severity: f.sev ? (o.severity || null) : null,
        time_context: {
          anchor: f.anchor === 'none' ? 'none' : f.anchor,
          elapsed_bucket: f.anchor === 'none' ? null : (tc.elapsed_bucket || 'unknown'),
          duration_bucket: tc.duration_bucket || null,
          trend: (f.type === 'chief_complaint' || f.type === 'symptom') ? (tc.trend || 'unknown') : (tc.trend || null)
        },
        source: o.source || 'clinician_selection',
        entered_at: o.entered_at || Date.now(),
        entered_seq: o.entered_seq || (++seq),
        evidence_version: KB().version,
        note: o.note || null
      };
      if (!['present', 'absent', 'unknown', 'not_assessed', 'pending'].includes(obs.status)) obs.status = 'present';
      // absent は値付き（「めまいなし」= その値だけ否定）も許す。値なし absent は項目全体の否定
      if (obs.status !== 'present' && !(obs.status === 'absent' && f.values && obs.value_code && f.values.some(v => v.code === obs.value_code))) obs.value_code = null;
      if (f.values && obs.status === 'present' && !obs.value_code) obs.value_code = f.values[0].code;
      return obs;
    }
    add(o, silent) {
      const obs = ClinicalState.normalize(o);
      this.observations.push(obs);
      delete this.deferred[obs.feature_id];
      return obs;
    }
    remove(obs_id) { this.observations = this.observations.filter(o => o.obs_id !== obs_id); }
    update(obs_id, patch) {
      const i = this.observations.findIndex(o => o.obs_id === obs_id);
      if (i < 0) return null;
      const merged = Object.assign({}, this.observations[i], patch, { time_context: Object.assign({}, this.observations[i].time_context, patch.time_context || {}) });
      this.observations[i] = ClinicalState.normalize(Object.assign(merged, { obs_id }));
      return this.observations[i];
    }
    static elapsedHours(obs) {
      const b = obs.time_context && obs.time_context.elapsed_bucket;
      if (!b) return 0;
      const h = KB().time.hours[b];
      return (h === null || h === undefined) ? null : h;
    }
    /* current observations: 非multi feature は最も新しい(elapsed最小)を採用。時間不明は最後に入力されたものを優先 */
    current() {
      const byF = {};
      for (const o of this.observations) (byF[o.feature_id] = byF[o.feature_id] || []).push(o);
      const out = [];
      for (const fid in byF) {
        const f = KB().feature[fid];
        const list = byF[fid];
        if (f.multi) {
          // multi: 各 value ごとに最新。'normal' が最新なら異常所見は superseded
          const byV = {};
          for (const o of list) { const k = o.status === 'present' ? o.value_code : o.status + (o.value_code ? ':' + o.value_code : ''); const cur = byV[k]; if (!cur || newer(o, cur)) byV[k] = o; }
          // 同じ値の present と absent は新しい方だけ残す
          for (const k in byV) { const o = byV[k]; if (o.status === 'absent' && o.value_code) { const p = byV[o.value_code]; if (p && newer(p, o)) delete byV[k]; else if (p) delete byV[o.value_code]; } }
          const vals = Object.values(byV);
          const normal = vals.find(o => o.value_code === 'normal');
          for (const o of vals) { if (normal && o !== normal && o.status === 'present' && newer(normal, o)) continue; out.push(o); }
        } else {
          let best = list[0];
          for (const o of list) if (newer(o, best)) best = o;
          out.push(best);
        }
      }
      return out.sort((a, b) => a.entered_seq - b.entered_seq);
    }
    superseded() {
      const cur = new Set(this.current().map(o => o.obs_id));
      return this.observations.filter(o => !cur.has(o.obs_id));
    }
    /* 同一 feature の過去観測との比較（ordinal な値集合なら上昇/低下） */
    trendOf(obs) {
      const f = KB().feature[obs.feature_id];
      if (!f.values || f.multi) return null;
      const prev = this.observations.filter(o => o.feature_id === obs.feature_id && o.obs_id !== obs.obs_id && o.status === 'present' && newer(obs, o));
      if (!prev.length) return null;
      let last = prev[0]; for (const o of prev) if (newer(o, last)) last = o;
      const idx = c => f.values.findIndex(v => v.code === c);
      const a = idx(last.value_code), b = idx(obs.value_code);
      if (a < 0 || b < 0 || a === b) return a === b ? 'same' : null;
      return b > a ? 'up' : 'down';
    }
    get(feature_id) { return this.current().filter(o => o.feature_id === feature_id); }
    /* value-level query helpers (used by Safety/DDx) */
    has(feature_id, values) {
      return this.get(feature_id).some(o => o.status === 'present' && (!values || values.includes(o.value_code)));
    }
    isAbsent(feature_id) { const l = this.get(feature_id); return l.length > 0 && l.every(o => o.status === 'absent'); }
    isObserved(feature_id) { return this.get(feature_id).some(o => o.status === 'present' || o.status === 'absent'); }
    isPending(feature_id) { return this.get(feature_id).some(o => o.status === 'pending'); }
    isNotAssessable(feature_id) { return this.get(feature_id).some(o => o.status === 'not_assessed'); }
    isUnknown(feature_id) { return this.get(feature_id).some(o => o.status === 'unknown'); }
    /* 取得済み・結果待ち・実施不可・不明 のいずれかなら「これ以上尋ねない」 */
    isAnswered(feature_id) { return this.isObserved(feature_id) || this.isPending(feature_id) || this.isNotAssessable(feature_id) || this.isUnknown(feature_id); }
    isStale(obs) {
      const f = KB().feature[obs.feature_id];
      const limit = f.fresh !== undefined ? f.fresh : KB().freshness[f.type];
      if (limit === null || limit === undefined) return false;
      const h = ClinicalState.elapsedHours(obs);
      return h !== null && h > limit;
    }
    /* 主訴（腹痛/下痢/嘔吐）の発症 tier1 と trend */
    chiefOnset() {
      const cc = this.current().filter(o => o.feature_type === 'chief_complaint' && o.status === 'present');
      if (!cc.length) return { tier1: 'unknown', trend: 'unknown', severity: null };
      // 同点時は KB の feature 順（腹痛>下痢>嘔吐）→ 発症が新しい順で決め、入力順に依存させない
      const fi = f => KB().features.findIndex(x => x.id === f);
      cc.sort((a, b) => (sevRank(b.severity) - sevRank(a.severity)) || (fi(a.feature_id) - fi(b.feature_id)) || ((ClinicalState.elapsedHours(a) ?? 1e9) - (ClinicalState.elapsedHours(b) ?? 1e9)));
      const o = cc[0];
      return { tier1: KB().time.tier1Of(o.time_context.elapsed_bucket), trend: o.time_context.trend || 'unknown', severity: o.severity, feature_id: o.feature_id };
    }
    /* 順序非依存の正規化ハッシュ（監査・回帰テスト用） */
    canonical() {
      const items = this.current().map(o => [o.feature_id, o.status, o.value_code || '', o.severity || '', o.time_context.elapsed_bucket || '', o.time_context.trend || ''].join('|')).sort();
      return JSON.stringify({ ctx: this.context, obs: items });
    }
    hash() { let h = 0, s = this.canonical(); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }
    toJSON() { return { case_token: this.case_token, context: this.context, observations: this.observations, deferred: this.deferred, created_at: this.created_at, kb_version: KB().version }; }
    static fromJSON(j) { const s = new ClinicalState({ case_token: j.case_token, context: j.context, created_at: j.created_at }); for (const o of j.observations || []) s.observations.push(ClinicalState.normalize(o)); s.deferred = j.deferred || {}; return s; }
  }
  function sevRank(s) { return s === 'severe' ? 3 : s === 'moderate' ? 2 : s === 'mild' ? 1 : 0; }
  // a is newer than b ?
  function newer(a, b) {
    const ha = ClinicalState.elapsedHours(a), hb = ClinicalState.elapsedHours(b);
    if (ha === null && hb === null) return a.entered_seq > b.entered_seq;
    if (ha === null) return false; if (hb === null) return true;
    if (ha !== hb) return ha < hb;
    return a.entered_seq > b.entered_seq;
  }
  DDX.ClinicalState = ClinicalState;
  DDX.util = { sevRank, newer };
})(typeof window !== 'undefined' ? window : globalThis);
