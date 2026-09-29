/* ============================================================
 * 患者管理 — 新規登録・患者別データ・フォルダ（同時に最大 100 人）
 *  保存先は IndexedDB（容量に余裕がある）→ 使えなければ localStorage → メモリ。
 *  一覧（'index': 患者の見出し・フォルダ・表示中の患者）と患者別データ（'pt:<id>': 症例 state・検査値・下書き）を分けて保存し、
 *  入力のたびに書き直すのはその患者の分だけにする。
 *  患者の呼び名は端末内にだけ保存し、AI にも監査ログにも送らない（監査ログは case_token のみ）。
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const MAX = 100, NAME_MAX = 30, FOLDER_MAX = 20;
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const copy = v => v == null ? v : JSON.parse(JSON.stringify(v));

  /* ---- 保存先 ---- */
  function memBackend() {
    const m = new Map();
    return { kind: 'memory', get: async k => m.has(k) ? copy(m.get(k)) : null, set: async (k, v) => { m.set(k, copy(v)); }, del: async k => { m.delete(k); } };
  }
  function lsBackend(ls, prefix) {
    prefix = prefix || 'ddxnav_db:';
    return {
      kind: 'localStorage',
      get: async k => { const v = ls.getItem(prefix + k); return v ? JSON.parse(v) : null; },
      set: async (k, v) => { ls.setItem(prefix + k, JSON.stringify(v)); },   // 容量超過は例外 → 呼び出し側で通知
      del: async k => { ls.removeItem(prefix + k); }
    };
  }
  function idbBackend(idb, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB timeout')), timeoutMs || 2000);
      let rq; try { rq = idb.open('ddxnav', 1); } catch (e) { clearTimeout(timer); reject(e); return; }
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onerror = () => { clearTimeout(timer); reject(rq.error); };
      rq.onblocked = () => { clearTimeout(timer); reject(new Error('IndexedDB blocked')); };
      rq.onsuccess = () => {
        clearTimeout(timer); const db = rq.result;
        const tx = (mode, fn) => new Promise((ok, ng) => {
          const t = db.transaction('kv', mode); const r = fn(t.objectStore('kv'));
          t.oncomplete = () => ok(r.result); t.onerror = t.onabort = () => ng(t.error || new Error('IndexedDB error'));
        });
        resolve({ kind: 'indexeddb', get: k => tx('readonly', s => s.get(k)).then(v => v === undefined ? null : v), set: (k, v) => tx('readwrite', s => s.put(copy(v), k)).then(() => { }), del: k => tx('readwrite', s => s.delete(k)).then(() => { }) });
      };
    });
  }
  async function pickBackend() {
    try { if (g.indexedDB) return await idbBackend(g.indexedDB); } catch (e) { /* 次へ */ }
    try { if (g.localStorage) { g.localStorage.setItem('ddxnav_db:probe', '1'); g.localStorage.removeItem('ddxnav_db:probe'); return lsBackend(g.localStorage); } } catch (e) { /* 次へ */ }
    return memBackend();
  }

  const P = {
    MAX, NAME_MAX, FOLDER_MAX,
    backend: null,
    index: { v: 1, currentId: null, folders: [], patients: [] },
    onError: null,   // 書き込み失敗（容量不足など）の通知先
    memBackend, lsBackend, idbBackend,

    async open(backend) {
      P.backend = backend || await pickBackend();
      const idx = await P.backend.get('index');
      P.index = { v: 1, currentId: null, folders: [], patients: [] };
      if (idx && Array.isArray(idx.patients)) Object.assign(P.index, idx);
      if (P.index.currentId && !P.get(P.index.currentId)) P.index.currentId = null;
      return P;
    },
    // 書き込み失敗は onError に通知したうえで reject する。待たない呼び出し（一覧の更新）は quiet() で握りつぶす
    write(key, value) { return P.backend.set(key, value).catch(e => { if (P.onError) P.onError(e); throw e; }); },
    persistIndex() { return P.write('index', P.index); },
    touchIndex() { P.persistIndex().catch(() => { }); },

    /* ---- 患者 ---- */
    count() { return P.index.patients.length; },
    full() { return P.count() >= MAX; },
    get(id) { return P.index.patients.find(p => p.id === id) || null; },
    current() { return P.get(P.index.currentId); },
    // folder: 'all' | 'none'（未分類）| フォルダ ID。新しく更新した順
    list(folder, query) {
      const q = clean(query, NAME_MAX).toLowerCase();
      return P.index.patients.filter(p => (!folder || folder === 'all' || (folder === 'none' ? !p.folderId : p.folderId === folder)) && (!q || p.name.toLowerCase().includes(q)))
        .sort((a, b) => b.updated - a.updated || b.created - a.created || a.name.localeCompare(b.name, 'ja', { numeric: true }));
    },
    create(o) {
      o = o || {};
      if (P.full()) throw new Error(`登録できるのは ${MAX} 人までです`);
      const now = Date.now(), n = P.count() + 1;
      const p = { id: uid('p'), name: clean(o.name, NAME_MAX) || `患者 ${n}`, folderId: P.folder(o.folderId) ? o.folderId : null, created: now, updated: now, context: { age_band: (o.context || {}).age_band || null, sex: (o.context || {}).sex || null }, summary: null, hash: null };
      P.index.patients.push(p); P.touchIndex();
      return p;
    },
    rename(id, name) { const p = P.get(id), nm = clean(name, NAME_MAX); if (!p || !nm) return false; p.name = nm; P.touchIndex(); return true; },
    move(id, folderId) { const p = P.get(id); if (!p) return false; p.folderId = P.folder(folderId) ? folderId : null; P.touchIndex(); return true; },
    async remove(id) {
      if (!P.get(id)) return false;
      P.index.patients = P.index.patients.filter(p => p.id !== id);
      if (P.index.currentId === id) P.index.currentId = null;
      await Promise.all([P.backend.del('pt:' + id), P.persistIndex()]);
      return true;
    },
    setCurrent(id) { P.index.currentId = P.get(id) ? id : null; P.touchIndex(); },
    loadData(id) { return P.backend.get('pt:' + id); },
    // data = { state, labValues, draft }。meta = { hash, summary }。内容（hash）が変わったときだけ更新日時を進める
    saveData(id, data, meta) {
      const p = P.get(id); if (!p) return Promise.resolve(false);
      meta = meta || {};
      if (meta.hash !== undefined && meta.hash !== p.hash) { if (p.hash !== null || (data.state && data.state.observations && data.state.observations.length)) p.updated = Date.now(); p.hash = meta.hash; }
      if (meta.summary !== undefined) p.summary = meta.summary;
      const c = data.state && data.state.context; if (c) p.context = { age_band: c.age_band || null, sex: c.sex || null };
      return Promise.all([P.write('pt:' + id, data), P.persistIndex()]).then(() => true);
    },

    /* ---- フォルダ（1 階層） ---- */
    folder(id) { return id ? P.index.folders.find(f => f.id === id) || null : null; },
    addFolder(name) {
      const nm = clean(name, FOLDER_MAX); if (!nm) return null;
      const ex = P.index.folders.find(f => f.name === nm); if (ex) return ex;
      const f = { id: uid('f'), name: nm, created: Date.now() }; P.index.folders.push(f); P.touchIndex(); return f;
    },
    renameFolder(id, name) { const f = P.folder(id), nm = clean(name, FOLDER_MAX); if (!f || !nm) return false; f.name = nm; P.touchIndex(); return true; },
    // フォルダを消しても患者は消さない（未分類に移す）
    removeFolder(id) {
      if (!P.folder(id)) return false;
      P.index.folders = P.index.folders.filter(f => f.id !== id);
      for (const p of P.index.patients) if (p.folderId === id) p.folderId = null;
      P.touchIndex(); return true;
    },
    folderCount(id) { return P.index.patients.filter(p => id === 'none' ? !p.folderId : p.folderId === id).length; },

    /* ---- バックアップ（患者名を含む） ---- */
    async exportAll() {
      const patients = [];
      for (const p of P.index.patients) patients.push(Object.assign(copy(p), { data: await P.loadData(p.id) }));
      return { app: 'ddx-navigator', kind: 'patients', v: 1, exported_at: new Date().toISOString(), folders: copy(P.index.folders), patients };
    },
    // 既存の患者は残し、ファイルの患者を追加する（同じ ID は取り込まない）。上限を超える分は取り込まない
    async importAll(obj) {
      if (!obj || obj.app !== 'ddx-navigator' || obj.kind !== 'patients' || !Array.isArray(obj.patients)) throw new Error('DDx Navigator の患者バックアップではありません');
      const fmap = {};
      for (const f of obj.folders || []) { const nf = P.addFolder(f && f.name); if (nf && f.id) fmap[f.id] = nf.id; }
      let added = 0, dup = 0, over = 0;
      for (const x of obj.patients) {
        if (!x || typeof x !== 'object') continue;
        if (x.id && P.get(x.id)) { dup++; continue; }
        if (P.full()) { over++; continue; }
        const p = { id: typeof x.id === 'string' && /^p[a-z0-9]{5,}$/.test(x.id) ? x.id : uid('p'), name: clean(x.name, NAME_MAX) || `患者 ${P.count() + 1}`, folderId: fmap[x.folderId] || null,
          created: +x.created || Date.now(), updated: +x.updated || Date.now(), context: { age_band: (x.context || {}).age_band || null, sex: (x.context || {}).sex || null }, summary: x.summary || null, hash: x.hash || null };
        P.index.patients.push(p);
        await P.write('pt:' + p.id, x.data && typeof x.data === 'object' ? x.data : {});
        added++;
      }
      await P.persistIndex();
      return { added, dup, over };
    }
  };
  DDX.Patients = P;
})(typeof window !== 'undefined' ? window : globalThis);
