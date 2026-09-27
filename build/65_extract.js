/* ============================================================
 * Free-text → 構造化 Observation
 *  1) PII scrub（送信前に必ず実行、除去内容を可視化）
 *  2) LLM 抽出（Claude Messages API、tool use で JSON を強制。カタログ外の語は捨てる）
 *  3) ローカル抽出（日本語ルール。API 不可時の fallback、数値は常にコード側で判定）
 * ============================================================ */
(function (g) {
  const DDX = g.DDX = g.DDX || {};
  const KB = () => DDX.KB;

  /* ---------------- PII scrub ---------------- */
  const AGE_BANDS = [[0, 17, 'lt18', '18歳未満'], [18, 29, '18-29', '18-29歳'], [30, 39, '30-39', '30代'], [40, 49, '40-49', '40代'], [50, 59, '50-59', '50代'], [60, 69, '60-69', '60代'], [70, 79, '70-79', '70代'], [80, 200, '80+', '80歳以上']];
  function ageBand(n) { for (const [a, b, code, label] of AGE_BANDS) if (n >= a && n <= b) return { code, label }; return null; }
  function scrub(text) {
    const removed = [];
    let t = String(text || '');
    const rep = (re, tag, fn) => { t = t.replace(re, (m, ...a) => { const r = fn ? fn(m, ...a) : tag; if (r !== m) removed.push({ kind: tag, text: m }); return r; }); };
    rep(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[メール]');
    rep(/0\d{1,4}[-‐ー–]\d{1,4}[-‐ー–]\d{3,4}|0\d{9,10}(?!\d)/g, '[電話]');
    rep(/(?<![\d-])〒?\s?\d{3}-\d{4}(?![\d-])/g, '[郵便番号]');
    rep(/(?:生年月日|誕生日)\s*[:：]?\s*[^\s、。]+/g, '[生年月日]');
    rep(/(?:昭和|平成|令和|S|H|R)\s?\d{1,2}[年./]\s?\d{1,2}[月./]\s?\d{1,2}日?/g, '[日付]');
    rep(/(?:19|20)\d{2}\s?[年./-]\s?\d{1,2}\s?[月./-]\s?\d{1,2}\s?日?/g, '[日付]');
    rep(/(?<![\d])\d{1,2}月\d{1,2}日/g, '[日付]');
    rep(/(?:患者|カルテ|受診|診察券)?(?:ID|番号|No\.?)\s*[:：]?\s*[A-Za-z0-9-]{4,}/gi, '[ID]');
    rep(/(?<![\d.])\d{6,}(?![\d.])/g, '[ID]');
    rep(/(?:北海道|東京都|京都府|大阪府|.{1,3}県)[^\s、。]{1,15}?(?:市|区|郡|町|村)[^\s、。]{0,20}/g, '[住所]');
    rep(/(?:氏名|患者名|名前|お名前)\s*[:：]?\s*[^\s、。]{1,10}/g, '[氏名]');
    rep(/[一-龥ぁ-んァ-ヶー]{1,6}(?:さん|様|氏|くん|ちゃん)(?![\wぁ-ん])/g, '[氏名]');
    rep(/(\d{1,3})\s*歳/g, '[年齢]', (m, n) => { const b = ageBand(parseInt(n, 10)); return b ? b.label : '[年齢]'; });
    return { text: t, removed };
  }

  /* ---------------- カタログ（LLM への説明とローカル辞書で共用） ---------------- */
  function catalogText() {
    const kb = KB(); const lines = [];
    for (const f of kb.features) {
      const vals = f.values ? ' 値: ' + f.values.map(v => `${v.code}=${v.label}`).join(', ') : ' 値: なし(present/absent で表現)';
      lines.push(`- ${f.id} [${kb.typeLabel[f.type]}] ${f.label}${vals}${f.sev ? ' ／ severity 必須候補' : ''}${f.anchor !== 'none' ? ' ／ 時間: ' + kb.anchorLabel[f.anchor] : ''}`);
    }
    const t = kb.time; const buckets = t.tier1.map(x => `${x.code}=${x.label}`).join(', ') + '; 詳細: ' + Object.values(t.tier2).flat().map(x => `${x.code}=${x.label}`).join(', ');
    return lines.join('\n') + `\n\n時間バケット(elapsed_bucket): ${buckets}\n経過(trend): ${kb.trend.map(x => `${x.code}=${x.label}`).join(', ')}\n程度(severity): mild=軽, moderate=中, severe=高\n文脈: age_band ∈ {${kb.context.age_band.map(x => x.code).join(', ')}}, sex ∈ {female, male}, pregnancy ∈ {no, possible, confirmed, unknown}`;
  }
  const SYSTEM = () => `あなたは救急・一般外来の医師の口述メモから、鑑別診断支援システムの構造化項目を抽出する係です。
出力は必ず record_findings ツールを1回呼び出して返してください。自由文は書きません。
ルール:
- 下のカタログにある feature_id と value_code だけを使う。該当しない情報は unmapped に短く列挙し、無理に当てはめない。
- 「なし/否定/陰性」は status=absent、「不明/聞けていない」は unknown。それ以外は present。値付き項目の特定の値だけを否定する場合（「めまいなし」「黒色便なし」）は status=absent に value_code も付ける。項目全体の否定は value_code=null。
- 数値は閾値でカテゴリ化する（例: 体温38.2→temp 38_39、CRP 5.2 mg/dL→crp 5_10、WBC 12,300→wbc 10_15、SBP 86→sbp lt90、SpO2 92→spo2 lt94）。
- 時間は相対表現から elapsed_bucket を選ぶ（「昨日から」→d_1_2、「3時間前」→h_1_3、「今朝」→hours、「先週」→w_1_2）。不明なら null。
- 主訴（腹痛・下痢・嘔吐）には severity を推定して付ける（激痛/我慢できない=severe、軽い=mild、それ以外=moderate）。悪化/改善/持続/変動/消失 は trend。
- 腹痛は部位ごとに value_code（rlq/ruq/epi/llq/luq/umb/diffuse/supra/flank_r/flank_l）。部位が複数なら複数項目。
- 画像所見は modality の feature（xray / us / ct）に、所見ごとに value_code を1つずつ付けて複数項目にする（例: 「CTで虫垂腫大」→ ct appendicitis、「CTで小腸拡張とニボー」→ ct sbo、「エコーで胆嚢壁肥厚」→ us gb、「CTで上腸間膜動脈の造影欠損」→ ct ischemia、「CTで尿管結石」→ ct stone、「CTで異常なし」→ ct normal）。
- 「free air なし」「虫垂腫大は指摘できず」のような否定の画像所見は項目として出さない（画像全体が正常なら normal を1つ）。該当コードの無い画像所見（腹水、リンパ節腫大など）は unmapped に入れる。
- 画像で偶発的に見つかった胆石は gallstone_hx（胆石あり）にする。
- 肝胆膵・脾・腎梗塞・腹水・腸重積・腸管壁肥厚などの CT 所見も ct の値にする。MRI/MRCP の同じ所見も ct に入れる（例: 「MRCPで総胆管拡張」→ ct biliary_dilation、「CTで門脈血栓」→ ct pvt、「CTで腹水」→ ct ascites）。身体診察の腹水（波動・濁音界移動）だけが ascites_exam。
- 画像の「肝硬変像」を既往（cirrhosis_hx）にしない。圧痛だけの記載を腹痛（abd_pain）にしない。「無痛性」「痛みを伴わない」は abd_pain を absent にする。
- 妊娠週数は pregnancy_status（14週未満 first_tri、それ以降 late）。免疫チェックポイント阻害薬（ニボルマブ等）の使用は ici_use。
- 年齢帯・性別・妊娠可能性が読み取れれば context に入れる。個人を特定する情報は出力しない。
- 各項目には根拠となった短い引用(quote)を付ける。

カタログ:
${catalogText()}`;

  const TOOL = () => ({
    name: 'record_findings', description: '抽出した構造化項目を記録する', strict: true,
    input_schema: {
      type: 'object', additionalProperties: false, required: ['items', 'context', 'unmapped'],
      properties: {
        items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['feature_id', 'value_code', 'status', 'elapsed_bucket', 'trend', 'severity', 'quote'],
          properties: { feature_id: { type: 'string' }, value_code: { type: ['string', 'null'] }, status: { type: 'string', enum: ['present', 'absent', 'unknown'] }, elapsed_bucket: { type: ['string', 'null'], description: '時間バケットのコード。不明なら null' }, trend: { type: ['string', 'null'], description: 'worsening | stable | improving | fluctuating | resolved | null' }, severity: { type: ['string', 'null'], description: 'mild | moderate | severe | null（主訴のみ）' }, quote: { type: 'string' } } } },
        context: { type: 'object', additionalProperties: false, required: ['age_band', 'sex', 'pregnancy'], properties: { age_band: { type: ['string', 'null'] }, sex: { type: ['string', 'null'], description: 'female | male | null' }, pregnancy: { type: ['string', 'null'], description: 'no | possible | confirmed | unknown | null' } } },
        unmapped: { type: 'array', items: { type: 'string' } }
      }
    }
  });

  /* ---------------- 検証（カタログ外を捨てる） ---------------- */
  function validate(raw) {
    const kb = KB(); const items = [];
    for (const it of (raw.items || [])) {
      const f = kb.feature[it.feature_id]; if (!f) continue;
      let value = it.value_code || null;
      if (f.values && it.status === 'present') { if (!value || !f.values.some(v => v.code === value)) continue; }
      if (f.values && it.status === 'absent' && value && !f.values.some(v => v.code === value)) value = null;
      if (!f.values || (it.status !== 'present' && it.status !== 'absent')) value = null;
      const eb = it.elapsed_bucket && kb.time.hours[it.elapsed_bucket] !== undefined ? it.elapsed_bucket : (f.anchor === 'none' ? null : 'unknown');
      const trend = ['worsening', 'stable', 'improving', 'fluctuating', 'resolved'].includes(it.trend) ? it.trend : 'unknown';
      const sev = ['mild', 'moderate', 'severe'].includes(it.severity) ? it.severity : null;
      items.push({ feature_id: f.id, status: ['present', 'absent', 'unknown'].includes(it.status) ? it.status : 'present', value_code: value, severity: f.sev ? sev : null, time_context: { elapsed_bucket: f.anchor === 'none' ? null : eb, trend }, quote: it.quote || '' });
    }
    const ctx = {}; const c = raw.context || {};
    if (c.age_band && kb.ageIndex[c.age_band] !== undefined) ctx.age_band = c.age_band;
    if (c.sex === 'female' || c.sex === 'male') ctx.sex = c.sex;
    if (['no', 'possible', 'confirmed', 'unknown'].includes(c.pregnancy)) ctx.pregnancy = c.pregnancy;
    return { items, context: ctx, unmapped: (raw.unmapped || []).slice(0, 10) };
  }

  /* ---------------- LLM 抽出（Claude Messages API, ブラウザ直接） ---------------- */
  const LLM = {
    config: { apiKey: '', model: 'claude-opus-5-5', confirm: true, timeoutMs: 60000 },
    models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5（最新・既定）' }, { id: 'claude-opus-5', label: 'Claude Opus 5' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5（速い・安い）' }, { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5（最速・最安）' }],
    ready() { return !!LLM.config.apiKey; },
    async extract(scrubbedText) {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), LLM.config.timeoutMs);
      const t0 = Date.now();
      try {
        const body = {
          model: LLM.config.model, max_tokens: 4096,
          system: [{ type: 'text', text: SYSTEM(), cache_control: { type: 'ephemeral' } }],
          tools: [TOOL()], tool_choice: { type: 'auto' },
          messages: [{ role: 'user', content: `次のメモから項目を抽出し、record_findings を呼び出してください。\n\n${scrubbedText}` }]
        };
        // Opus 5.5 / Opus 5 / Sonnet 5: thinking は既定で adaptive（5.5 は無効化不可）。抽出は effort:low で十分。
        // tool_choice は 'auto'（Opus 5.5 は any/tool の強制指定を受け付けない）。Haiku 4.5 は effort 非対応。
        if (/haiku-4-5/.test(LLM.config.model)) { /* no effort */ } else body.output_config = { effort: LLM.config.effort || 'low' };
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': LLM.config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify(body)
        });
        if (!res.ok) { let msg = 'HTTP ' + res.status; try { const j = await res.json(); msg += ': ' + (j.error && j.error.message || ''); } catch (e) { } throw new Error(msg); }
        const j = await res.json();
        if (j.stop_reason === 'refusal') throw new Error('モデルが応答を拒否しました');
        const tu = (j.content || []).find(b => b.type === 'tool_use' && b.name === 'record_findings');
        if (!tu) throw new Error('構造化出力が返りませんでした');
        const out = validate(tu.input);
        return Object.assign(out, { ok: true, provider: 'llm', model: j.model, latency: Date.now() - t0, usage: j.usage });
      } finally { clearTimeout(timer); }
    }
  };

  /* ---------------- ローカル抽出（日本語ルール） ---------------- */
  const NEG = '(?:なし|無し|ない|認めず|認めない|認められず|否定|陰性|\\(-\\)|（-）|−|マイナス|みられず|見られず|みられない|見られない|はない|なく|なかった|認めなかった|指摘できず|指摘されず|指摘なし|描出されず|検出されず|ありません|乏しい|弱い|不能)';
  const LOC = [['rlq', '右下腹'], ['ruq', '右上腹|右季肋|右肋骨弓'], ['epi', '心窩|みぞおち|(?<![右左])上腹部'], ['llq', '左下腹'], ['luq', '左上腹|左季肋|左肋骨弓'], ['umb', '臍|へそ|おへそ'], ['diffuse', '腹部全体|全体的|びまん|お腹全体|腹全体'], ['supra', '(?<![右左])下腹部|恥骨上'], ['flank_r', '右側腹|右背|右腰|右CVA'], ['flank_l', '左側腹|左背|左腰|左CVA']];
  const ENDO = '(内視鏡|EGD|GIF|胃カメラ|大腸カメラ|EUS|超音波内視鏡|カプセル|CF|肛門鏡|小腸鏡)[^。]*';
  const IMGP = '(CT|ＣＴ|MRI|MRCP|画像)[^。]*';
  const USP = '(エコー|超音波|US|FAST)[^。]*';
  const KW = [ // [feature_id, regex, value|null]
    ['diarrhea', '水様(便|下痢)', 'watery'], ['diarrhea', '血性下痢|血便を伴う下痢|粘血便', 'bloody'], ['diarrhea', '粘液(便|性下痢)', 'mucous'], ['diarrhea', '下痢|軟便', 'watery'],
    ['vomiting', '胆汁性(嘔吐)?|緑色の嘔吐', 'bilious'], ['vomiting', '吐血|(鮮血|血液|血)を(吐|嘔吐)|血性(の)?嘔吐', 'hematemesis'], ['vomiting', 'コーヒー残渣', 'coffee_ground'], ['vomiting', '嘔吐|吐いた|吐く', 'nonbilious'],
    ['nausea', '嘔気|吐き気|悪心|むかつき', null], ['anorexia', '食欲(低下|不振|なし)|食思不振|食べられない', null], ['fever_sub', '発熱|(?<!灼)熱感|悪寒|寒気|熱がある|高熱', null],
    ['obstipation', '排ガス(停止|なし)|排便(停止|なし|がない)|ガスが出ない|便が出ない', null], ['gi_bleed', '黒色便|タール便|メレナ', 'melena'], ['gi_bleed', '血便|下血|(黒赤|暗赤|赤黒)(い)?便', 'hematochezia'],
    ['dysuria', '排尿時痛|排尿痛|頻尿|残尿感', null], ['vaginal_bleeding', '不正(性器)?出血|性器出血|(妊娠|膣|腟|子宮)[^。]{0,16}出血', null], ['vaginal_discharge', '帯下|おりもの', null], ['jaundice_sub', '黄疸|眼球黄染', null], ['weight_loss', '体重(減少|が減)', null],
    ['chest_sx', '胸痛|胸背部痛|胸部痛|胸が苦しい|呼吸苦|呼吸困難|息切れ|冷汗', null], ['syncope', '失神|気を失|前失神|意識消失', null], ['sick_contact_food', '周囲に同(様|じ)症状|家族も|食中毒|生もの|生肉|生牡蠣|生ガキ|加熱不十分|生焼け|ユッケ|レバ刺し', null], ['scrotal_pain', '陰嚢(の)?痛|精巣(の)?痛|睾丸', null],
    ['pain_onset_char', '(突然|急に|突発|急激)[^。、]{0,12}(痛|腹痛|疝痛)|(痛|腹痛)[^。、]{0,6}(突然|急に|突発|急激)|突然発症|突発する', 'sudden'], ['pain_onset_char', '徐々に|だんだん|次第に', 'gradual'],
    ['pain_char', '食後(に|の)?(痛|増悪|悪化)|食後[^。、]{0,4}(腹痛|痛み|疼痛)|食事(で|後)(痛|増悪)', 'postprandial'], ['pain_char', '排便(後|で|すると)[^。、]{0,6}(軽快|改善|楽に)', 'relief_defecation'], ['pain_char', '疝痛|波がある|間欠的|差し込む', 'colicky'], ['pain_char', '持続(性|的)(の)?痛|持続痛|持続する痛|ずっと痛', 'constant'], ['pain_char', '(臍(周囲)?|心窩部|みぞおち|上腹部)から右下|右下腹部(へ|に)移動|痛み(が|の)?移動|移動性(の)?(痛|疼痛)', 'migrating_rlq'], ['pain_char', '背中(に|へ|への)(の)?(放散|抜け)|背部(へ|に|への)(の)?放散|背部痛を伴|胸背部痛', 'radiate_back'], ['pain_char', '肩(甲部)?(に|へ|への)(の)?(放散|抜け)', 'radiate_shoulder'], ['pain_char', '鼠径(部)?(に|へ)(放散|抜け)|陰部(に|へ)放散', 'radiate_groin'],
    ['pain_worse_moving', '体動で(増悪|悪化)|動くと痛|振動で痛|歩くと痛|咳で痛', null],
    ['lmp_delayed', '月経(が)?(遅れ|遅延)|生理が(遅れ|来て)', null], ['prior_abd_surgery', '開腹|腹部手術|手術歴|(虫垂|胆嚢|胃|大腸|子宮)(切除|摘出)|帝王切開', null], ['alcohol_heavy', '大酒|多量飲酒|大量(の)?飲酒|深酒|アルコール(多飲|依存|性)|毎日飲酒|飲酒歴|飲酒後|大量のアルコール', null],
    ['nsaid_aspirin', 'NSAID|ロキソ|ロキソニン|イブプロフェン|ボルタレン|アスピリン|バファリン|鎮痛薬', null], ['anticoag', '抗凝固|ヘパリン|ワーファリン|ワルファリン|DOAC|エリキュース|イグザレルト|リクシアナ|プラザキサ|抗血小板|クロピドグレル', null],
    ['recent_abx', '抗菌薬|抗生剤|抗生物質', null], ['hospitalized_recent', '最近(の)?入院|入院歴|施設入所|退院後', null], ['travel', '海外渡航|渡航歴|渡航後|旅行から|旅行先|海外旅行|海外で', null],
    ['af_vascular', '心房細動|AF|Af|動脈硬化|閉塞性動脈|心筋梗塞の既往|脳梗塞の既往', null], ['cv_risk', '高血圧|脂質異常|高脂血症|喫煙|タバコ', null], ['diabetes', '糖尿病|DM|インスリン', null],
    ['immunosupp', 'ステロイド|免疫抑制|化学療法|抗がん剤|化療|(臓器|腎|肝|骨髄|造血幹細胞)移植', null], ['gallstone_hx', '胆石', null], ['ibd_hx', '潰瘍性大腸炎|クローン|Crohn|IBD|炎症性腸疾患', null], ['divertic_hx', '憩室.{0,4}(既往|歴)|憩室症', null], ['pud_hx', '(胃|十二指腸)潰瘍(の)?(既往|歴)|潰瘍歴|(難治性|多発性|多発する|反復|再発)[^。、]{0,6}潰瘍', null], ['hernia_hx', 'ヘルニア(の)?既往|ヘルニア歴|脱腸', null], ['similar_episodes', '以前(に)?も同(様|じ)|同様の発作|繰り返し', null],
    ['rebound_guarding', '反跳痛|Blumberg|ブルンベルグ|筋性防御|腹膜刺激', null], ['rigidity', '板状硬', null], ['tender_rlq', 'McBurney|マックバーニー|右下腹部(の|に)?圧痛', null], ['tender_ruq', '右上腹部(の|に)?圧痛|右季肋部(の|に)?圧痛', null], ['murphy', 'Murphy|マーフィー', null],
    ['tender_llq', '左下腹部(の|に)?圧痛', null], ['tender_epi', '心窩部(の|に)?圧痛|(?<![右左])上腹部(の|に)?圧痛', null], ['distension', '腹部膨満|腹満|腹部(は|が)?[^。、]{0,4}膨満|(?<!(腹壁|鼠径|大腿|臍)部?(の)?)膨隆|お腹が張', null],
    ['bowel_sounds', '腸(蠕動)?音(の)?亢進|金属音', 'hyper'], ['bowel_sounds', '腸(蠕動)?音(の)?(減弱|低下)', 'hypo'], ['bowel_sounds', '腸(蠕動)?音(の)?消失', 'absent'], ['bowel_sounds', '腸(蠕動)?音(は)?正常', 'normal'],
    ['cva_tender', 'CVA|肋骨脊柱角|(?<!肝(臓)?(の)?)叩打痛', null], ['pulsatile_mass', '拍動性(の)?腫瘤|拍動する', null], ['hernia_irreducible', '還納(不能|できない|しない)|嵌頓|戻らない|押し戻せない', null], ['pain_disproportion', '所見に比して|所見に乏しい(のに|が)|痛みが強い割に', null],
    ['psoas_obturator', 'psoas|腸腰筋徴候|閉鎖筋徴候|obturator', null], ['dehydration_signs', '脱水|口腔(内)?乾燥|ツルゴール|皮膚の張り', null], ['rectal_blood', '直腸診で(血|出血)|直腸診.*血', null], ['adnexal_tender', '付属器(の)?圧痛|子宮頸部移動痛|頸(部|管)移動痛|CMT', null],
    ['scrotal_exam', '陰嚢(の)?(腫脹|圧痛|腫大)|精巣(の)?(腫脹|圧痛)', 'tender_swollen'],
    // 神経症状（拡張項目 neuro_sx）: 値ごとに明示ルール
    ['neuro_sx', '末梢神経障害|ニューロパチー|多発(性)?(単)?神経炎|(四肢|手足|両手|両足|手|足)(の|に)?(しびれ|痺れ)|しびれ|痺れ|知覚(障害|鈍麻)|感覚(障害|鈍麻)|筋力低下|脱力|下垂足|手袋靴下|(四肢|手|足|下肢|上肢)(の)?麻痺', 'paresthesia_weakness'],
    ['neuro_sx', '頭痛|項部硬直|髄膜刺激', 'headache'], ['neuro_sx', '錯乱|失調|眼球運動障害|眼振', 'confusion_ataxia'],
    ['neuro_sx', 'めまい|眩暈|回転性', 'vertigo'], ['neuro_sx', '眼痛|視力(低下|障害)|霧視|かすみ|視野', 'eye_pain_visual'], ['neuro_sx', '局所神経|片麻痺|構音障害|失語|顔面麻痺', 'focal_deficit'], ['neuro_sx', '神経(学的)?(症状|所見|異常|脱落)', null],
 ['skin_pallor_cold', '末梢冷感|冷感|蒼白|顔色不良', null], ['consciousness', '意識(障害|レベル低下|混濁|変容)|JCS|GCS\\s*1[0-4]|傾眠|せん妄', 'altered'], ['consciousness', '意識(清明|は清明|レベル清明)', 'alert'],
    ['hcg', '(血清)?hCG[^。、]{0,4}(著明)?(高値|上昇)', 'pos'], ['hcg', '(妊娠反応|hCG|HCG)(は|が)?\\s*(陽性|\\(\\+\\)|（\\+）|\\+)', 'pos'], ['hcg', '(妊娠反応|hCG|HCG)(は|が)?\\s*(陰性|\\(-\\)|（-）|-)', 'neg'],
    ['urinalysis', '(血尿|(?<!便)潜血(?!便)).*(膿尿|白血球)|(膿尿|白血球).*(血尿|(?<!便)潜血(?!便))', 'both'], ['urinalysis', '血尿|(?<!便)潜血(?!便)', 'hematuria'], ['urinalysis', '尿(蛋白|タンパク)(は)?(陰性|なく|なし|認めない|乏しい)|尿所見(は)?(正常|乏しい|異常なし)|尿(蛋白|タンパク)(は)?少な|尿(沈渣|定性)[^。、]{0,8}(正常|異常なし|(は|が)?(ない|なし|認めない))', 'normal'], ['urinalysis', '膿尿|尿中白血球|尿WBC', 'pyuria'], ['urinalysis', '尿(検査|所見)(は)?正常|尿所見なし', 'normal'],
    ['troponin', 'トロポニン\\s*(陽性|上昇|\\+)', 'pos'], ['troponin', 'トロポニン\\s*(陰性|正常|-)', 'neg'], ['ecg', '(心電図|ECG)[^。]*((尖鋭|テント状)(な)?T波|QRS(幅)?(の)?(拡大|延長))', 'peaked_t'], ['ecg', '(心電図|ECG).*(ST(上昇|低下|変化)?|虚血|陰性T波|T波(の)?(陰転|平低化))', 'ischemic'], ['ecg', '(心電図|ECG).*(心房細動|AF|Af)', 'af'], ['ecg', '(心電図|ECG)(は|に)?(正常|異常なし)', 'normal'],
    ['lipase', '(?<!(腹水|穿刺液|ドレーン|排液)[^。]{0,8})(リパーゼ|アミラーゼ).*(3倍|著明|高値|上昇)', 'ge3x'], ['lipase', '(?<!(腹水|穿刺液|ドレーン|排液)[^。]{0,8})(リパーゼ|アミラーゼ).*(軽度上昇|やや高)', 'lt3x'], ['lipase', '(?<!(腹水|穿刺液|ドレーン|排液)[^。]{0,8})(リパーゼ|アミラーゼ).*(正常|基準内)', 'normal'],
    ['liver_enz', '(AST|ALT|肝酵素|トランスアミナーゼ|肝機能).*(上昇|高値|高い|異常)', 'elevated'], ['liver_enz', '(AST|ALT|肝酵素).*(正常|基準内)', 'normal'], ['bili', '(ビリルビン|T-?Bil).*(上昇|高値|高い)', 'elevated'], ['bili', '(ビリルビン|T-?Bil).*(正常|基準内)', 'normal'],
    ['alp_ggt', '(ALP|γ-?GTP|GGT|胆道系酵素).*(上昇|高値|高い)', 'elevated'], ['renal', '(Cre|クレアチニン|BUN|腎機能).*(上昇|高値|悪化|障害)|(?<![A-Za-z])Cr(?![A-Za-z])[^。、]{0,8}(上昇|高値|高い)|(急性)?腎障害|腎不全|AKI', 'elevated'], ['hb', '(Hb|ヘモグロビン|貧血).*(低下|進行)|貧血あり|貧血', 'low'],
    ['acidosis', '代謝性アシドーシス|アシドーシス', 'metabolic'], ['ddimer', 'D-?ダイマー\\s*(上昇|高値|陽性)', 'elevated'], ['ddimer', 'D-?ダイマー\\s*(正常|陰性)', 'normal'],
    ['stool_test', '(CD|C\\.?\\s?diff|ディフィシル).*(陽性|\\+)', 'cdiff_pos'], ['stool_test', '便培養.*(陽性|検出)', 'culture_pos'], ['stool_test', '(便培養|CDトキシン|C\\.? ?difficile|CD(トキシン|検査|抗原))[^。]*(陰性)', 'neg'], ['stool_test', '志賀毒素|ベロ毒素|O157|STEC|EHEC', 'culture_pos'],
    ['xray', '(?<!CT[^。]*)(?<!エコー[^。]*)(?<!超音波[^。]*)(free ?air|フリーエア|遊離ガス)', 'free_air'], ['xray', '(?<!CT[^。]*)(?<!エコー[^。]*)(?<!超音波[^。]*)(鏡面像|ニボー|niveau)', 'air_fluid'], ['xray', '(?<!CT[^。]*)(?<!エコー[^。]*)(?<!超音波[^。]*)(腸管|小腸)(の)?拡張', 'dilated_loops'],
    ['us', '(エコー|超音波|US|FAST).*(虫垂(腫大|腫脹)|虫垂炎)', 'appendix'], ['us', '(エコー|超音波|US|FAST).*(胆嚢(壁)?肥厚|胆嚢腫大|胆嚢結石|sonographic)', 'gb'], ['us', '(エコー|超音波|US|FAST).*(総胆管拡張|胆管拡張)', 'cbd_dilated'], ['us', '(エコー|超音波|US|FAST).*(腹水|液体貯留|ダグラス窩|腹腔内出血)', 'free_fluid'], ['us', '(エコー|超音波|US|FAST).*水腎', 'hydro'], ['us', '(エコー|超音波|US|FAST).*(大動脈瘤|AAA)', 'aaa'], ['us', '(エコー|超音波|US|FAST).*(付属器|卵巣)[^。、]{0,12}(腫大|腫瘤|嚢胞|嚢腫)', 'adnexal'], ['us', '(エコー|超音波|US)(は|で)(異常なし|正常)', 'normal'],
    ['ct', 'CT.*虫垂(?![^。、]{0,12}(嚢胞|粘液|正常|風船|液体))(炎|腫大|腫脹|の腫大|の腫脹)?', 'appendicitis'], ['ct', 'CT.*憩室炎', 'diverticulitis'], ['ct', 'CT.*(free ?air|遊離ガス|フリーエア|腹腔内(遊離)?ガス)', 'free_air'],
    ['ct', 'CT.*(腸閉塞|イレウス|SBO|閉塞起点|(小腸|腸管)(の)?拡張|ニボー|鏡面像|niveau)', 'sbo'],
    ['ct', 'CT.*(上腸間膜動脈症候群|SMA症候群|十二指腸(の)?(圧排|狭窄|通過障害)|大動脈.{0,6}上腸間膜動脈.{0,6}角)', 'duodenal_compression'], ['ct', '(?![^。]*(症候群|十二指腸|の角|角狭小|角が|脾|腎))CT.*(腸管虚血|壁造影不良|造影不良|造影欠損|造影(効果)?が(弱|低下|乏し)|SMA|上腸間膜動脈|腸間膜動脈|門脈ガス|腸管気腫|(?<!(門脈|静脈|SMV)(内)?(の)?)血栓)', 'ischemia'], ['ct', 'CT.*膵(炎|腫大|周囲)', 'pancreatitis'], ['ct', 'CT.*(大動脈瘤|解離|AAA|フラップ|flap|偽腔|intimal|後腹膜血腫|大動脈周囲[^。、]{0,6}血腫)', 'aortic'],
    ['ct', 'CT.*(尿管結石|尿路結石|腎結石|(尿管|腎|膀胱|尿路)[^。、]{0,10}結石)', 'stone'], ['ct', 'CT.*(大腸炎|腸炎|(大腸|結腸|S状結腸|直腸|盲腸|上行結腸|横行結腸|下行結腸)[^。]{0,6}壁(の)?肥厚)', 'colitis'], ['ct', 'CT.*(胆嚢炎|胆管炎|胆嚢壁肥厚|胆嚢周囲)', 'cholecystitis'], ['ct', 'CT.*膿瘍', 'abscess'], ['ct', 'CT.*(嵌頓|(?<!内)ヘルニア|筋膜欠損|ヘルニア門|鼠径管|大腿管|(脂肪|腸管)[^。、]{0,6}(突出|脱出))', 'hernia'], ['ct', '(CT|MRI).*(付属器|卵巣)[^。、]{0,14}(腫大|腫瘤|腫瘍|嚢胞|嚢腫|捻転|出血)', 'adnexal'], ['ct', 'CT.*(軸捻|捻転|渦巻き|whirl|ワール)', 'volvulus'],
    ['ct', 'CT(は|で|では|上|:|：|も)?\\s*(明らかな)?(異常なし|異常所見なし|正常|特記所見なし|特記すべき所見なし|有意な所見なし)', 'normal'],
    ['gallstone_hx', '(CT|エコー|超音波|US).*(胆嚢結石|胆石)', null],
    // 腹部CT（ct_other / ct_wall_mass / 肝胆膵画像を集約した値。MRI/MRCP の同じ所見もここ）
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((肝|肝臓)(内)?(の)?(腫瘤|腫瘍|SOL|占拠性病変|結節)|肝(転移|細胞癌)|HCC)', 'liver_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(脂肪肝|肝(の)?脂肪(沈着|化))', 'fatty_liver'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(肝硬変|肝(表面|辺縁)(の)?(凹凸|不整|鈍)|肝(の)?萎縮)', 'cirrhotic_liver'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((肝内|肝外|総|上流)?胆管[^。、]{0,8}(拡張|狭窄))', 'biliary_dilation'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(胆嚢(の)?壁(の)?肥厚|胆嚢(の)?(腫瘤|腫瘍|隆起))', 'gb_wall_thick'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(膵(臓)?(頭部|体部|尾部|体尾部)?[^。、]{0,6}(腫瘤|腫瘍|癌|低吸収|結節)|(主)?膵管(の)?拡張|拡張した(主)?膵管)', 'pancreatic_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(膵[^。、]{0,20}(嚢胞|貯留|被包化)|被包化壊死|WON|仮性嚢胞|IPMN|嚢胞性膵)', 'pancreatic_cyst'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(びまん性(の)?膵腫大|ソーセージ様|capsule-like)', 'diffuse_pancreas_swelling'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(膵[^。、]{0,6}(石|石灰化)|膵管(の)?不整)', 'chronic_pancreatitis'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(門脈[^。、]{0,6}(血栓|閉塞)|(上)?腸間膜静脈(内)?(の)?血栓|SMV(内)?(の)?血栓)', 'pvt'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腹水|腹腔内(の)?液体貯留)', 'ascites'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(胃(の)?壁(の)?肥厚|胃壁肥厚|胃(壁)?[^。、]{0,6}(腫瘤|不整|病変))', 'gastric_wall_thick'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(脾梗塞|脾[^。、]{0,6}(楔状|造影欠損|梗塞))', 'splenic_infarct'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(脾[^。、]{0,6}(破裂|損傷|裂創|裂傷))', 'splenic_rupture'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(肝脾腫|脾腫|肝腫大)', 'hepatosplenomegaly'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腎梗塞|腎[^。、]{0,6}(楔状|造影欠損|造影不良|梗塞))', 'renal_infarct'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((後腹膜|腹腔内|腸間膜)(の)?(腫瘤|腫瘍))', 'retro_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腸管(壁)?(内)?気腫|腸管壁内(の)?ガス|pneumatosis)', 'pneumatosis'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腸腰筋(の)?(膿瘍|腫大))', 'psoas_abscess'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腹直筋鞘[^。、]{0,6}血腫|腹壁[^。、]{0,6}血腫)', 'wall_hematoma'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((腸)?重積|target sign|ターゲットサイン)', 'intussusception'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((腸管|小腸|空腸|回腸|十二指腸|大腸|結腸|S状結腸|直腸|盲腸|上行結腸|横行結腸|下行結腸)[^。]{0,6}壁(の)?肥厚|腸管壁肥厚)', 'wall_thick'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((腸管|小腸|空腸|回腸|十二指腸|大腸|結腸|S状結腸|直腸|盲腸)[^。]{0,10}(腫瘤|腫瘍|全周性(の)?(壁肥厚|狭窄)|apple core))', 'bowel_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(内ヘルニア|傍十二指腸|網嚢孔|beak sign)', 'internal_hernia'],
    // 検査（拡張項目。明示ルールのみで抽出）
    ['fobt', '便潜血(反応)?\\s*(検査)?\\s*(は|で)?\\s*(陽性|\\(\\+\\)|（\\+）|\\+)', 'pos'], ['fobt', '便潜血(反応)?\\s*(検査)?\\s*(は|で)?\\s*(陰性|\\(-\\)|（-）|-)', 'neg'],
    ['electrolyte', '低Na|低ナトリウム', 'hypona'], ['electrolyte', '高K(?![A-Za-z])|高カリウム', 'hyperk'], ['electrolyte', '低K(?![A-Za-z])|低カリウム', 'hypok'], ['electrolyte', '高Ca|高カルシウム', 'hyperca'],
    ['ck', '(?<![A-Za-z])(CK|CPK)(?!-?MB)\\s*(の)?(上昇|高値)', 'elevated'], ['ck', '(?<![A-Za-z])(CK|CPK)(?!-?MB)\\s*(は)?(正常|基準内)', 'normal'],
    ['ldh', '(?<![A-Za-z])(LDH?|乳酸脱水素酵素)\\s*(の)?(上昇|高値)', 'elevated'], ['ldh', '(?<![A-Za-z])LDH?\\s*(は)?(正常|基準内)', 'normal'],
    ['sil2r', '(sIL-?2R|可溶性IL-?2(受容体|レセプター))\\s*(の)?(上昇|高値)', 'elevated'],
    ['ammonia', '(アンモニア|NH3)\\s*(の)?(上昇|高値)|高アンモニア', 'elevated'], ['ammonia', '(アンモニア|NH3)\\s*(は)?(正常|基準内)', 'normal'],
    ['hemolysis_labs', '溶血(所見|性)?(あり|を認め)|ハプトグロビン(の)?(低値|低下|感度以下)|網(状)?赤血球(の)?(増加|上昇)|間接(型)?ビリルビン(優位)?', 'positive'],
    ['ici_use', '免疫チェックポイント阻害|(?<![A-Za-z])ICI(?![A-Za-z])|ニボルマブ|オプジーボ|ペムブロリズマブ|キイトルーダ|イピリムマブ|ヤーボイ|アテゾリズマブ|テセントリク|デュルバルマブ|イミフィンジ|アベルマブ|バベンチオ|トレメリムマブ|イジュド|セミプリマブ|リブタヨ|抗PD-?L?1|抗CTLA-?4', null],
    ['pregnancy_status', '産褥|産後|出産後|分娩後', 'postpartum'], ['pregnancy_status', '不妊治療|排卵誘発|体外受精|hCG投与', 'infertility_tx'], ['pregnancy_status', '妊娠初期|つわり', 'first_tri'], ['pregnancy_status', '妊娠(中期|後期)|臨月', 'late'],
    ['diarrhea_pattern', '脂肪便|油っぽい便|便が(水に)?浮く', 'steatorrhea'],
    // ---- 内視鏡（値ごとの明示ルール）----
    ['endoscopy', ENDO + '(出血源(は|が)?(なく|ない|認めない|不明|同定できない)|異常(所見)?(は|が)?(ない|なし|認めない|認めず)|器質的異常(は|が)?(ない|なし|認めない)|(ほぼ)?正常(?!粘膜に覆われ)(で|であ|と|だ|$))', 'normal'],
    ['endoscopy', ENDO + '(Mallory|マロリー|(縦走|縦)[^。、]{0,4}(粘膜)?裂(創|傷)|粘膜裂(創|傷))', 'mallory_weiss'],
    ['endoscopy', ENDO + '(粘膜下腫(瘍|瘤)|SMT|正常粘膜に覆われた[^。、]{0,6}(隆起|腫瘤)|固有筋層(由来)?(の)?腫瘤|GIST)', 'smt'],
    ['endoscopy', ENDO + '(胃体部(優位)?(の)?[^。、]{0,4}萎縮|逆萎縮)', 'atrophic_body'],
    ['endoscopy', ENDO + '(直腸から[^。、]{0,8}連続|連続(する|性)(の)?[^。、]{0,6}びまん性|びまん性(の)?(炎症|発赤))', 'uc_continuous'],
    ['endoscopy', ENDO + '(縦走潰瘍|敷石|非連続|skip)', 'crohn_longitudinal'],
    ['endoscopy', ENDO + '((下行|S状)結腸[^。、]{0,10}(浮腫|縦走潰瘍|発赤)|区域性)', 'ischemic_left'],
    ['endoscopy', ENDO + '偽膜', 'pseudomembrane'], ['endoscopy', ENDO + '(打ち抜き|下掘れ|深い潰瘍|深掘れ)', 'punched_out_ulcer'],
    ['endoscopy', ENDO + '憩室[^。、]{0,8}(出血|露出血管|凝血)', 'diverticular_bleed'], ['endoscopy', ENDO + '(下部)?直腸[^。、]{0,12}潰瘍', 'rectal_ulcer'],
    ['endoscopy', ENDO + '(血管拡張|拡張(した)?血管|血管異形成|angiodysplasia|angioectasia|AVM)', 'angioectasia'], ['endoscopy', ENDO + '静脈瘤', 'varices'],
    ['endoscopy', ENDO + '(食道[^。、]{0,12}(びらん|粘膜傷害|mucosal break)|逆流性食道炎|食道胃接合部[^。、]{0,8}びらん)', 'esophagitis'],
    ['endoscopy', ENDO + '(輪状溝|縦走溝|気管様)', 'eoe'], ['endoscopy', ENDO + '(白苔|白色(の)?斑|カンジダ|付着性(の)?白色)', 'candida_ulcer'],
    ['endoscopy', ENDO + '(虫体|アニサキス)', 'anisakis'], ['endoscopy', ENDO + '異物', 'foreign_body'],
    ['endoscopy', ENDO + '((胃|十二指腸|球部|胃角|前庭部|下行脚)[^。、]{0,10}潰瘍|(胃|十二指腸)[^。]*潰瘍(が)?多発)', 'peptic_ulcer'],
    ['endoscopy', ENDO + '(胃|前庭部|胃体部)[^。、]{0,8}(びらん|発赤|AGML)', 'erosive_gastritis'],
    ['endoscopy', ENDO + '(不整(な)?[^。、]{0,8}(狭窄|潰瘍|腫瘤)|(?<!(非|粘膜下|由来の|筋層の))腫(瘍|瘤)|進行癌|全周性(の)?(狭窄|腫瘤)|狭窄)', 'tumor'],
    ['endoscopy', ENDO + '(大腸炎|びまん性(の)?浮腫)', 'colitis'], ['endoscopy', ENDO + '(易出血|びまん出血|出血性(の)?粘膜)', 'hemorrhagic_diffuse'],
    ['endoscopy', ENDO + '(食道(の)?(著明な)?拡張|残渣)', 'achalasia'], ['endoscopy', ENDO + '(巨大皺襞|(皺襞|ひだ)(の)?(著明な)?肥厚)', 'giant_folds'],
    ['endoscopy', ENDO + '((胃|胃底腺|胃体部|前庭部)[^。、]{0,10}ポリープ|胃底腺ポリープ|過形成性ポリープ)', 'gastric_polyp'],
    // ---- 肛門・腹部腫瘤・尿便の色・月経 ----
    ['anal_sx', '排便時[^。、]{0,6}(鮮血|出血|血液)|(鮮血|血液)[^。、]{0,4}(紙|便器)|紙に[^。、]{0,6}血', 'bleed_on_defecation'], ['anal_sx', '肛門(から|に|より)?[^。、]{0,4}(脱出|腫瘤)|脱肛|直腸(が)?脱出', 'prolapse'],
    ['anal_sx', '排便時(の)?痛|排便痛|肛門(周囲|部)?(の)?痛|肛門痛|肛門[^。、]{0,6}(痛|切れ)', 'pain_on_defecation'], ['anal_sx', '排膿|膿[^。、]{0,4}出|下着(の)?汚染', 'discharge'],
    ['perianal_disease', '痔瘻|肛門周囲膿瘍|瘻管|外口|索状硬結|肛門周囲[^。、]{0,14}(腫脹|発赤|硬結)|肛門[^。]*(瘻孔|開口部|二次口|管状構造)|(瘻孔|開口部|二次口|管状構造)[^。]*肛門', null],
    ['abd_mass', '(心窩部|上腹部|季肋)[^。、]{0,6}(腫瘤|しこり)(を|が)?(触|蝕)', 'upper'], ['abd_mass', '(下腹部|恥骨上|骨盤)[^。、]{0,6}(腫瘤|しこり)(を|が)?(触|蝕)', 'lower_pelvic'], ['abd_mass', '臍[^。、]{0,6}(腫瘤|しこり)(を|が)?(触|蝕)', 'umbilical'], ['abd_mass', '(?<!拍動性(の)?)(腫瘤|しこり)(を|が)?(触知|触れ)|腹部腫瘤(を)?触知', 'diffuse'],
    ['urine_stool_color', '(暗)?赤色(の)?尿|尿(が|は)?(暗)?赤|ポートワイン|赤褐色(の)?尿|コーラ(色|様)(の)?尿', 'red_urine'], ['urine_stool_color', 'ビリルビン尿|(褐色|紅茶色)(の)?尿|尿(が|の色が)?濃', 'dark_urine'], ['urine_stool_color', '(灰)?白色便|淡黄色便|便(が|の色が)?白', 'pale_stool'],
    ['menstrual_relation', '月経(時|中|前後|開始|期)[^。、]{0,8}(痛|増悪|反復|悪化)|月経痛|月経困難|月経と(一致|関連)|月経開始とともに|月経量(が)?(増加|多い)|過多月経', 'with_menses'], ['menstrual_relation', '月経前[^。、]{0,6}(増悪|悪化)|月経前後', 'premenstrual'], ['menstrual_relation', '排卵期|月経(周期の)?中間(期)?|月経と月経の中間|月経の中間', 'midcycle'],
    // ---- 血清学・自己抗体・腫瘍マーカー・特殊検査 ----
    ['hepatitis_serology', '(IgM-?HA|HA-?IgM|IgM型HA|HAV)[^。]{0,16}(陽性|\\+)', 'hav_igm_pos'], ['hepatitis_serology', '(HBs抗原|IgM-?HBc|IgM型抗HBc|HBV-?DNA)[^。]{0,16}(陽性|\\+)', 'hbs_ag_igm_hbc_pos'], ['hepatitis_serology', 'HCV[^。、]{0,12}(陽性|\\+)', 'hcv_pos'],
    ['hepatitis_serology', '(HEV|IgA-?HEV)[^。]{0,16}(陽性|\\+)', 'hev_pos'], ['hepatitis_serology', '(EBV|VCA-?IgM|CMV-?IgM|CMV抗原血症)[^。、]{0,8}(陽性|\\+)|異型リンパ球', 'ebv_cmv_pos'], ['hepatitis_serology', '肝炎ウイルス(マーカー)?[^。、]{0,6}(陰性|すべて陰性)|ウイルスマーカー(は)?陰性', 'neg'],
    ['autoantibodies', '(抗核抗体|ANA|抗平滑筋抗体)[^。、]{0,6}(陽性|高値|\\+)|IgG(?!4)[^。、]{0,4}(高値|上昇)', 'ana_asma_pos'], ['autoantibodies', '(抗ミトコンドリア(M2)?抗体|AMA)[^。、]{0,6}(陽性|\\+)', 'ama_pos'],
    ['autoantibodies', '抗(ds)?DNA抗体|補体[^。、]{0,4}(低下|低値|消費)', 'sle_serology'], ['autoantibodies', '抗(組織)?(tTG|トランスグルタミナーゼ)|抗EMA|抗筋内膜', 'ttg_pos'], ['autoantibodies', '抗(胃)?壁細胞抗体|抗内因子抗体', 'parietal_pos'], ['autoantibodies', '(MPO-?|PR3-?)?ANCA[^。、]{0,6}(陽性|\\+)', 'anca_pos'],
    ['igg4', 'IgG4[^。、]{0,8}(高値|上昇|高い)', 'elevated'],
    ['endocrine_lab', 'TSH[^。、]{0,4}(高値|上昇|著増|増加|高い)|甲状腺機能低下', 'tsh_high'], ['endocrine_lab', 'TSH[^。、]{0,4}(低値|低下|抑制)|甲状腺機能亢進|(遊離|free ?)T4[^。、]{0,4}高値', 'tsh_low'], ['endocrine_lab', 'コルチゾール[^。、]{0,6}(低値|低下|低い)', 'cortisol_low'],
    ['tumor_marker', 'CEA[^。、]{0,6}(上昇|高値|高い)', 'cea_high'], ['tumor_marker', 'CA-?19-?9[^。、]{0,6}(上昇|高値|高い)', 'ca199_high'], ['tumor_marker', '(AFP|PIVKA-?(II|Ⅱ)?)[^。、]{0,8}(上昇|高値|高い)', 'afp_pivka_high'], ['tumor_marker', 'CA-?125[^。、]{0,6}(上昇|高値|高い)', 'ca125_high'],
    ['iron_overload', '(フェリチン|トランスフェリン飽和度)[^。、]{0,12}(高|上昇)|鉄過剰|鉄沈着', null], ['ceruloplasmin_low', 'セルロプラスミン[^。、]{0,4}(低値|低下|低い|低く)', null],
    ['gastrin_high', 'ガストリン[^。、]{0,6}(高値|上昇|高い)|高ガストリン', null], ['b12_low', '(ビタミン)?B12[^。、]{0,4}(低値|低下|欠乏)|大球性貧血|悪性貧血', null],
    ['porphyrin_urine', 'ポルホビリノーゲン|PBG|δ-?アミノレブリン酸|ALA[^。、]{0,4}(高値|上昇)', null], ['stool_a1at', 'α1-?アンチトリプシン|α1AT', null],
    ['acidosis', '代謝性アルカローシス|低Cl(性)?(血症)?', 'alkalosis'], ['fobt', '潜血便', 'pos'],
    // ---- 既往・診察 ----
    ['gastrectomy_hx', '胃(全)?切除|幽門側胃切除|胃(亜)?全摘|Billroth|ルーワイ|Roux', null], ['dyspareunia', '性交(時)?痛', null], ['heart_failure_hx', '心不全', null],
    ['jvd', '頸静脈(の)?(怒張|拡張)', null], ['abd_bruit', '血管雑音|bruit', null], ['succussion_splash', '振水音', null],
    ['pulse_deficit', '(上肢|左右)[^。、]{0,6}(血圧|脈拍)[^。、]{0,4}差|(脈拍|血圧)(の)?左右差', null],
    // ---- 画像（新しい値）----
    ['us', USP + '(target|ターゲット|同心円|pseudo-?kidney|重積)', 'target'], ['us', USP + '肝[^。、]{0,12}(腫瘤|腫瘍|結節|膿瘍|低エコー(域|性)|SOL)', 'liver_mass'],
    ['us', USP + '(胆嚢[^。、]{0,12}(ポリープ|隆起|突出)|コメット|RAS|壁内[^。、]{0,4}(小)?嚢胞)', 'gb_polyp'],
    ['us', '((エコー|超音波|US|MRI)[^。]*子宮[^。、]{0,12}(腫大|腫瘤|筋層|嚢胞状|小嚢胞)|子宮(が|は)?[^。、]{0,8}(腫大|腫瘤)|子宮筋腫|junctional zone)', 'uterine'],
    ['us', USP + '(リンパ節[^。、]{0,4}(腫大|腫脹)|(腫大|腫脹)(した)?リンパ節)', 'lymph_nodes'], ['us', USP + '器質的異常(は|が)?(なく|ない|なし|認めない)', 'normal'],
    ['ct', IMGP + '(閉鎖係蹄|closed ?loop|クローズドループ)', 'closed_loop'],
    ['ct', IMGP + '((脾|腹腔|肝|腎|腸間膜|内臓|膵十二指腸)[^。、]{0,6}動脈瘤|(小|微小)動脈瘤|脾門部[^。、]{0,4}動脈瘤)', 'visceral_aneurysm'],
    ['ct', IMGP + '(櫛状|comb sign|腸間膜血管[^。、]{0,6}(濃染|増生|怒張))', 'mesenteric_comb'], ['ct', IMGP + '((小腸|腸管)(の)?壁[^。、]{0,8}浮腫|(小腸|腸管)浮腫)', 'bowel_edema'],
    ['ct', IMGP + '(肝被膜|肝周囲)[^。、]{0,8}(濃染|造影)', 'liver_capsule'], ['ct', IMGP + '(正中弓状靱帯|腹腔動脈起始部[^。、]{0,8}(狭窄|圧排)|呼気[^。]*腹腔動脈)', 'celiac_stenosis'],
    ['ct', '(CT|MRI|MRCP|エコー|超音波)[^。]*肝内(胆管)?[^。、]{0,8}結石|肝内結石', 'intrahepatic_stones'], ['ct', IMGP + '(共通管|膵胆管合流異常|膵・胆管合流)', 'pbm'],
    ['ct', IMGP + '(肝静脈|下大静脈|IVC)[^。、]{0,10}(拡張|うっ滞|逆流)', 'ivc_dilated'],
    ['ct', '肝(臓)?(内|両葉|右葉|左葉|S\\d)?[^。、]{0,20}(腫瘤|腫瘍|結節|SOL)(?!マーカー)', 'liver_mass'],
    ['ct', IMGP + '肝[^。、]{0,12}(膿瘍|辺縁(が)?(造影|濃染)[^。、]{0,12}(液体|低吸収))', 'abscess'], ['ct', IMGP + '器質的異常(所見)?(は|が)?(なく|ない|なし|認めない)', 'normal'],
    ['xray', '(X線|レントゲン|XP|単純写真)[^。]*((横行|S状)?結腸[^。、]{0,6}(著明(な|に)?)?拡張|巨大(な)?結腸|コーヒー豆|coffee bean)', 'colon_dilated'], ['xray', 'コーヒー豆|coffee bean', 'coffee_bean'],
    ['xray', '(X線|レントゲン|XP)[^。]*腸管ガス[^。、]{0,4}(貯留|増加|拡張)', 'dilated_loops'],
    // ---- 別版問題集で判明した言い回し（検査名のない文でも画像専用語は拾う）----
    ['ct', '(長い)?共通管|膵胆管合流異常|膵・胆管合流', 'pbm'], ['ct', '胆道気腫|pneumobilia|(胆道|胆管)内(の)?(ガス|空気)', 'pneumobilia'], ['ct', '閉鎖係蹄|closed ?loop|クローズドループ|C字型|U字型', 'closed_loop'],
    ['us', 'target sign|ターゲットサイン|同心円状', 'target'], ['ct', '偽腔|intimal flap', 'aortic'], ['ct', '肝被膜[^。]{0,16}(癒着|濃染)|弦状癒着|violin', 'liver_capsule'],
    ['ct', '肝(左葉|右葉|内)[^。]{0,16}胆管[^。]{0,16}結石', 'intrahepatic_stones'], ['ct', '腹直筋[^。、]{0,10}(血腫|高吸収|腫瘤)', 'wall_hematoma'],
    ['ct', '(胃|噴門)[^。]{0,16}(横隔膜より上|胸腔内|縦隔内)', 'hiatal_hernia'], ['ct', IMGP + '(被膜|壁)を持つ[^。、]{0,10}(腔|嚢胞|貯留|液体)', 'pancreatic_cyst'],
    ['abd_mass', '下腹部(に)?腫瘤', 'lower_pelvic'], ['abd_mass', '上腹部(に)?腫瘤', 'upper'],
    ['us', '(子宮内|子宮腔内)[^。、]{0,8}(胎児|胎嚢|心拍)|胎児心拍', 'iup'], ['cervical_os_open', '(子宮口|頸管口)[^。、]{0,4}(開大|開いて)|妊娠組織[^。、]{0,8}(排出|残)', null],
    ['kf_ring', '角膜[^。、]{0,8}(褐色|輪)|Kayser|KF輪', null], ['meckel_scan', 'シンチ[^。]{0,24}(異所性胃粘膜|集積)|異所性胃粘膜', null],
    ['aaa_known', '(腹部)?大動脈(瘤|が拡張)[^。、]{0,12}(指摘|既往|経過観察)|大動脈瘤(の)?(既往|指摘)', null],
    // ---- 症例問題集（検証用の検討）で判明した言い回し ----
    ['endoscopy', '鳥のくちばし|bird.?s beak|(下部食道括約筋|LES)(の)?弛緩(不全|障害)|造影[^。]*(拡張した食道|食道(が|の)?[^。、]{0,6}拡張)', 'achalasia'],
    ['endoscopy', ENDO + '(多発(する)?[^。、]{0,12}ポリープ|ポリープ[^。、]{0,4}(多発|多数|数百|無数)|ポリポーシス|数百個)', 'polyposis'],
    ['endoscopy', ENDO + '(食道[^。、]{0,14}(円柱上皮|腸上皮化生)|Barrett|バレット|舌状[^。、]{0,8}(円柱上皮|伸び))', 'barrett'],
    ['endoscopy', ENDO + '((露出(した)?血管|動脈(が)?露出|動脈[^。、]{0,6}(拍動性に|噴出性に)?出血)(?![^。、]{0,10}(を伴う|のある)?潰瘍)|Dieulafoy|デュラフォイ)', 'dieulafoy'],
    ['endoscopy', ENDO + '(慢性(活動性)?胃炎|萎縮性胃炎|鳥肌胃炎|前庭部[^。、]{0,6}萎縮)', 'chronic_gastritis'],
    ['anal_sx', '直腸脱|全層性(の)?脱出|同心円状(の)?(粘膜)?(ひだ|皺襞)|直腸(が)?[^。、]{0,6}脱出', 'rectal_prolapse'],
    ['ingestion_event', '(酸|アルカリ|洗剤|洗浄剤|漂白剤|腐食性|強酸|強アルカリ|農薬)[^。、]{0,12}(誤飲|服用|飲ん|嚥下)|誤飲[^。、]{0,6}(酸|アルカリ|洗剤|漂白剤)', 'caustic'],
    ['ingestion_event', '(異物|魚骨|魚の骨|PTP|電池|義歯|硬貨)[^。、]{0,6}(誤飲|誤嚥|飲み込)', 'foreign_body'],
    ['ingestion_event', '(内視鏡(検査|治療|処置)?|ポリペクトミー|ESD|EMR|アブレーション)(の)?(後|直後)', 'endoscopy_recent'],
    ['skin_finding', '(帯状|片側)[^。、]{0,12}(水疱|皮疹|発疹)|小水疱|帯状疱疹|集簇(した|する)[^。、]{0,4}(小)?水疱|水疱[^。、]{0,6}(集簇|帯状)', 'zoster_vesicles'], ['skin_finding', '紫斑|点状出血', 'purpura'], ['skin_finding', '結節性紅斑|壊疽性膿皮症', 'erythema_nodosum'],
    ['skin_finding', '色素沈着|色素斑', 'pigmentation'], ['skin_finding', 'くも状血管腫|手掌紅斑', 'spider_angioma_palmar'],
    ['flushing', '(顔面)?紅潮|潮紅|flushing', null], ['urine_5hiaa', '5-?HIAA', null], ['macroglossia', '舌(の)?(腫大|肥大)|巨舌', null],
    ['proteinuria', '(?<!尿)蛋白尿|尿(蛋白|タンパク)(陽性|\\+)', null], ['estrogen_use', '経口避妊薬|ピル|エストロゲン|ホルモン補充', null],
    ['palpitations', '動悸', null], ['catecholamine_high', '(メタネフリン|カテコラミン|VMA)[^。、]{0,6}(高値|上昇)', null], ['clubbing', 'ばち指', null],
    ['platypnea', '(立位|座位)で[^。、]{0,4}(悪化|増悪)する(息切れ|呼吸困難)|platypnea', null],
    ['hp_positive', '(Helicobacter|ヘリコバクター|H\\.? ?pylori|ピロリ(菌)?)[^。、]{0,8}(陽性|感染|\\+)|迅速ウレアーゼ(試験)?陽性|尿素呼気試験陽性|らせん状菌', null],
    ['paracentesis', 'SAAG[^。、]{0,6}(1\\.1以上|≧1\\.1|高値|>1\\.1)|漏出性腹水', 'saag_high'], ['paracentesis', '腹水[^。]*(好中球|多形核)[^。、]{0,8}(250|増多|上昇)', 'neutrophil_high'], ['paracentesis', '血性腹水', 'bloody'],
    ['paracentesis', '腹水[^。]*アミラーゼ[^。、]{0,4}(高値|上昇)', 'amylase_high'], ['paracentesis', '(腹水)?細胞診[^。、]{0,4}(陽性|クラスV|class ?V|悪性)|腹水[^。]*(腫瘍細胞|悪性細胞)', 'cytology_pos'],
    ['paracentesis', '(腹水|胸水)[^。]*(リンパ球優位|ADA)|ADA[^。、]{0,4}(高値|上昇)', 'lymph_ada'],
    ['stool_test', '原虫|虫卵|アメーバ|ジアルジア|クリプトスポリジウム|糞線虫|赤血球(を)?貪食', 'parasite'],
    ['ct', IMGP + '(結腸|大腸)[^。、]{0,8}(著明(な|に)?|びまん性に)?拡張', 'colon_dilated'],
    ['ct', IMGP + '(腹膜[^。、]{0,8}(肥厚|結節|播種)|大網[^。、]{0,6}(肥厚|ケーキ)|omental cake)', 'peritoneal_thick'],
    ['ct', IMGP + '(異常血管|血管(の)?集簇|早期静脈還流|造影剤(の)?(漏出|血管外漏出)|extravasation)', 'vascular_lesion'],
    ['ct', IMGP + '(胃(が)?[^。、]{0,12}(著明(な|に)?|極度に)?拡張|拡張した胃)', 'gastric_dilation'],
    ['ct', IMGP + '(肝静脈|肝部下大静脈)[^。、]{0,6}(閉塞|血栓|狭窄|途絶|膜様)', 'hepatic_vein_occlusion'],
    ['ct', IMGP + '(胆道気腫|pneumobilia|胆管内(の)?(ガス|空気))', 'pneumobilia'], ['ct', IMGP + '(回腸|小腸|空腸|腸管)(内)?(の)?[^。、]{0,12}結石', 'bowel_stone'],
    ['ct', IMGP + '胃(が)?[^。、]{0,8}(回転|捻転|軸捻)', 'gastric_volvulus'],
    ['ct', '(膵管)?癒合不全|膵管分離|副乳頭(へ|に)?[^。、]{0,4}(排液|開口)|背側膵管優位', 'pancreas_divisum'],
    ['ct', IMGP + '虫垂[^。、]{0,12}(嚢胞状|粘液|拡張|風船状|広が)', 'appendiceal_mucocele'],
    ['ct', '(scalloping|スキャロッピング|ゼリー状(の)?腹水|粘液性腹水|腹膜表面[^。、]{0,6}低吸収)', 'pseudomyxoma'],
    ['ct', IMGP + '副腎[^。、]{0,6}(腫瘤|腫瘍|結節)', 'adrenal_mass'],
    ['ct', '(食道裂孔[^。、]{0,10}(越え|脱出|滑脱)|胸腔内に[^。、]{0,6}(滑脱|脱出)|裂孔ヘルニア)', 'hiatal_hernia'], ['endoscopy', ENDO + '(食道裂孔ヘルニア|裂孔ヘルニア|胃の滑脱)', 'hiatal_hernia'],
    // 肝腫瘤・膵嚢胞の造影パターン（疾患の区別に使う古典的所見）
    ['ct', IMGP + '(辺縁(から|より)?[^。、]{0,6}結節状[^。、]{0,6}濃染|中心(へ|に向かって)[^。、]{0,6}(造影|濃染)が(進|広が)|fill-?in|遷延性濃染)', 'hemangioma_pattern'],
    ['ct', IMGP + '(動脈相[^。、]{0,6}(濃染|早期濃染)|早期濃染|多血性)', 'arterial_enhancement'], ['ct', IMGP + '(washout|ウォッシュアウト|門脈相[^。、]{0,6}(低吸収|洗い出し)|後期相[^。、]{0,6}低吸収)', 'washout'],
    ['ct', IMGP + '((輪状|リング状|辺縁)(の)?(造影|濃染)(を示す|される)?[^。、]{0,6}(腫瘤|病変|結節))', 'ring_enhancement'],
    ['ct', IMGP + '(多数の(小)?嚢胞[^。、]{0,8}石灰化|石灰化[^。、]{0,8}嚢胞|多房性[^。、]{0,4}嚢胞[^。、]{0,8}石灰化)', 'cystic_calcified'],
    ['ct', IMGP + '(壁在結節|分枝膵管|主膵管(と|に)[^。、]{0,6}交通|交通する[^。、]{0,10}嚢胞|厚い被膜[^。、]{0,10}嚢胞|卵巣様間質|膵[^。、]{0,12}粘液)', 'mucinous_cyst'],
    ['ct', IMGP + '((腹腔動脈|上腸間膜動脈|SMA)[^。、]{0,12}動脈硬化|動脈硬化性[^。、]{0,4}狭窄|上腸間膜動脈[^。、]{0,8}(狭窄|閉塞))', 'visceral_artery_stenosis'],
  ];
  /* 「〜を造影CTで認める」のように検査名が所見の後に来る語順にも対応（前置きの検査名の代わりに、同じ文の後ろにあればよい） */
  for (const rule of KW) {
    for (const P of [IMGP, ENDO, USP]) {
      if (typeof rule[1] === 'string' && rule[1].startsWith(P)) { const rest = rule[1].slice(P.length); rule[1] = '(?:' + P + rest + '|' + rest + '(?=[^。]*' + P.slice(0, P.indexOf(')') + 1) + '))'; break; }
    }
  }
  function bucketTime(text) {
    const m1 = text.match(/(\d+)\s*(分|時間|日|週間|週|か月|ヶ月|カ月)\s*(前|ほど前|くらい前|から)/);
    if (m1) { const n = parseInt(m1[1], 10), u = m1[2];
      if (u === '分') return n < 10 ? 'min_lt10' : n <= 30 ? 'min_10_30' : 'min_30_60';
      if (u === '時間') return n <= 3 ? 'h_1_3' : n <= 6 ? 'h_3_6' : n <= 12 ? 'h_6_12' : 'h_12_24';
      if (u === '日') return n <= 2 ? 'd_1_2' : n <= 7 ? 'd_3_7' : 'w_1_2';
      if (/週/.test(u)) return n <= 2 ? 'w_1_2' : 'w_3_4';
      return n <= 3 ? 'm_1_3' : 'm_gt3'; }
    if (/一昨日|おととい/.test(text)) return 'd_1_2'; if (/昨日|昨夜|昨晩/.test(text)) return 'd_1_2'; if (/今朝|今日|本日|数時間/.test(text)) return 'hours';
    if (/数日|ここ数日|先日/.test(text)) return 'days'; if (/先週|数週/.test(text)) return 'weeks'; if (/先月|数か月|数ヶ月|数カ月/.test(text)) return 'months'; if (/さっき|先ほど|数分/.test(text)) return 'minutes';
    return null;
  }
  function trendOf(text) { if (/悪化|増悪|強くなっ|ひどくなっ/.test(text)) return 'worsening'; if (/改善|軽快|楽になっ|落ち着い/.test(text)) return 'improving'; if (/消失|なくなった|治った/.test(text)) return 'resolved'; if (/変動|波がある|良くなったり/.test(text)) return 'fluctuating'; if (/持続|続いて|ずっと/.test(text)) return 'stable'; return 'unknown'; }
  function sevOf(text) { if (/激痛|激しい|耐えられ|我慢できない|強い痛み|かなり痛|七転八倒|最悪/.test(text)) return 'severe'; if (/軽い|軽度|軽微|少し痛|やや痛/.test(text)) return 'mild'; return 'moderate'; }
  function negated(text, idx, len) {
    const after = text.slice(idx + len, idx + len + 40); const before = text.slice(Math.max(0, idx - 4), idx);
    // 「腹膜刺激徴候はない」「虫垂切除歴はなく」: 名詞の語尾を挟んだ否定
    if (new RegExp('^\\s*(徴候|兆候|所見|症状|症|サイン|(の)?(使用|服用|内服)?歴|の既往|既往|の所見)?\\s*(は|も|の|が)?\\s*' + NEG).test(after)) return true;
    // 「体重減少や貧血はなく」「胆管拡張や腫瘤はなく」: 並列の否定（読点・句点をまたがない）
    if (new RegExp('^((や|と|・|、|および|及び)[^。、にでをがはも]{1,12}){1,4}(は|も|が)?\\s*' + NEG).test(after)) return true;
    return /(なし|無|否定)$/.test(before);
  }
  const B = (v, cuts) => { for (const [lim, code] of cuts) if (v < lim) return code; return cuts[cuts.length - 1][1]; };
  function numbers(text, add) {
    let m;
    for (m of text.matchAll(/(?:体温|BT|KT|T)\s*[:：=]?\s*(3\d(?:\.\d)?|4\d(?:\.\d)?)\s*(?:℃|度|°C)?/g)) { const v = parseFloat(m[1]); if (v >= 34 && v <= 43) add('temp', v < 36 ? 'lt36' : v < 37.5 ? 'lt375' : v < 38 ? '375_38' : v < 39 ? '38_39' : 'ge39', m[0]); }
    for (m of text.matchAll(/(?:脈拍|脈|HR|PR|心拍数?)\s*[:：=]?\s*(\d{2,3})/g)) { const v = +m[1]; if (v >= 20 && v <= 250) add('hr', v < 60 ? 'lt60' : v <= 100 ? '60_100' : v <= 120 ? '100_120' : 'gt120', m[0]); }
    for (m of text.matchAll(/(?:血圧|BP)\s*[:：=]?\s*(\d{2,3})\s*[\/／]\s*\d{2,3}/g)) { const v = +m[1]; add('sbp', v < 90 ? 'lt90' : v <= 100 ? '90_100' : v <= 140 ? '100_140' : 'gt140', m[0]); }
    for (m of text.matchAll(/(?:収縮期血圧|sBP|SBP)\s*[:：=]?\s*(\d{2,3})/g)) { const v = +m[1]; add('sbp', v < 90 ? 'lt90' : v <= 100 ? '90_100' : v <= 140 ? '100_140' : 'gt140', m[0]); }
    for (m of text.matchAll(/(?:SpO2|SpO₂|サチュレーション|酸素飽和度)\s*[:：=]?\s*(\d{2,3})/g)) { const v = +m[1]; add('spo2', v < 94 ? 'lt94' : 'ge94', m[0]); }
    for (m of text.matchAll(/(?:呼吸数|RR)\s*[:：=]?\s*(\d{1,2})/g)) { const v = +m[1]; add('rr', v <= 20 ? 'le20' : v <= 24 ? '21_24' : 'gt24', m[0]); }
    for (m of text.matchAll(/(?:WBC|白血球)\s*[:：=]?\s*(\d{1,3}(?:[,，]\d{3})?(?:\.\d+)?)/g)) { let v = parseFloat(m[1].replace(/[,，]/g, '')); if (v < 100) v *= (v < 1 ? 100000 : 1000); add('wbc', v < 4000 ? 'lt4' : v <= 10000 ? '4_10' : v <= 15000 ? '10_15' : 'gt15', m[0]); }
    for (m of text.matchAll(/CRP\s*[:：=]?\s*(\d{1,3}(?:\.\d+)?)\s*(mg\/L)?/gi)) { let v = parseFloat(m[1]); if (m[2]) v /= 10; add('crp', v < 1 ? 'lt1' : v <= 5 ? '1_5' : v <= 10 ? '5_10' : 'gt10', m[0]); }
    for (m of text.matchAll(/(?:乳酸|Lac|ラクテート|lactate)\s*[:：=]?\s*(\d{1,2}(?:\.\d+)?)/gi)) { const v = parseFloat(m[1]); add('lactate', v < 2 ? 'lt2' : v <= 4 ? '2_4' : 'gt4', m[0]); }
    for (m of text.matchAll(/(?:血糖|BS|Glu|グルコース)(?:値)?(?:は|が)?\s*[:：=]?\s*(\d{2,4})/gi)) { const v = +m[1]; add('glucose', v > 250 ? 'gt250' : v < 70 ? 'lt70' : 'normal', m[0]); }
    for (m of text.matchAll(/(?:Hb|ヘモグロビン)\s*[:：=]?\s*(\d{1,2}(?:\.\d+)?)/g)) { const v = parseFloat(m[1]); add('hb', v < 11 ? 'low' : 'normal', m[0]); }
    // 検査値パネルと同じ変換（DDX.LABS.resolve）。AST と ALT が同じ文にあればパターンも出る
    if (DDX.LABS && DDX.LABS.resolve) {
      const LV = {}, pick = (id, re, f) => { const mm = text.match(re); if (mm) { let v = parseFloat(String(mm[1]).replace(/,/g, '')); if (f) v = f(v, mm); if (v >= 0) LV[id] = v; } };
      pick('na', /(?<![A-Za-z])Na\s*[:：=]?\s*(1\d{2})(?!\d)/); pick('k', /(?<![A-Za-z])K\s*[:：=]?\s*(\d(?:\.\d+)?)(?![\d.])/); pick('ca', /(?<![A-Za-z])Ca\s*[:：=]?\s*(\d{1,2}(?:\.\d+)?)(?![\d.\-])/);
      pick('ck', /(?<![A-Za-z])C(?:P)?K(?!-?MB)\s*[:：=]?\s*(\d{2,6})/); pick('ldh', /(?<![A-Za-z])LDH?\s*[:：=]?\s*(\d{2,5})/); pick('nh3', /(?:NH3|NH₃|アンモニア)\s*[:：=]?\s*(\d{2,4})/);
      pick('plt', /(?:Plt|PLT|血小板)\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(万)?/, (v, mm) => mm[2] ? v : DDX.LABS.byId.plt.norm(v));
      pick('ast', /(?<![A-Za-z])(?:AST|GOT)\s*[:：=]?\s*(\d{1,3}(?:,\d{3})+|\d{1,5})/); pick('alt', /(?<![A-Za-z])(?:ALT|GPT)\s*[:：=]?\s*(\d{1,3}(?:,\d{3})+|\d{1,5})/);
      for (const x of DDX.LABS.resolve(LV, {})) add(x.f, x.code, Object.keys(LV).join('/'), x.status);
    }
    for (m of text.matchAll(/妊娠\s*(\d{1,2})\s*週/g)) add('pregnancy_status', +m[1] < 14 ? 'first_tri' : 'late', m[0]);
    // 定性的な表現（数値がない「CRP上昇」「白血球増多」「血圧低下」など）。数値で入っていればそちらが先に立つ
    const Q = (re, fn) => { const mm = text.match(re); if (mm && !negated(text, mm.index, mm[0].length)) fn(mm); };
    Q(/CRP[^。、\d]{0,8}?(著明|著しく|高度)?[^。、\d]{0,4}?(高値|上昇|高い|陽性)/, mm => add('crp', mm[1] ? 'gt10' : /軽度/.test(mm[0]) ? '1_5' : '5_10', mm[0]));
    Q(/(?<!尿(中)?)(白血球|WBC)[^。、\d]{0,8}?(著明|著しく)?[^。、\d]{0,4}?(増多|増加|上昇|高値|高い)/, mm => add('wbc', mm[3] ? 'gt15' : '10_15', mm[0]));
    Q(/(?<!尿(中)?)(白血球|WBC)[^。、\d]{0,6}(減少|低下|低値)/, mm => add('wbc', 'lt4', mm[0]));
    Q(/乳酸(値)?[^。、\d]{0,4}(上昇|高値|高い)/, mm => add('lactate', '2_4', mm[0]));
    Q(/(アルブミン|Alb)[^。、\d]{0,6}(低値|低下|低い)|低アルブミン/, mm => add('chronic_liver_labs', 'alb_low', mm[0]));
    for (m of text.matchAll(/(?:アルブミン|Alb)\s*[:：=]?\s*(\d(?:\.\d)?)\s*(?:g\/dL)?/g)) add('chronic_liver_labs', 'alb_low', m[0], parseFloat(m[1]) < 3.5 ? 'present' : 'absent');
    Q(/PT(-?INR)?[^。、\d]{0,4}(延長|低下)|凝固(能)?(異常|障害)/, mm => add('chronic_liver_labs', 'pt_prolonged', mm[0]));
    for (m of text.matchAll(/PT-?INR\s*[:：=]?\s*(\d(?:\.\d+)?)/g)) if (parseFloat(m[1]) > 1.5) add('chronic_liver_labs', 'pt_prolonged', m[0]);
    Q(/血小板[^。、\d]{0,4}(減少|低下|低値)/, mm => add('chronic_liver_labs', 'plt_low', mm[0]));
    Q(/低血糖/, mm => add('glucose', 'lt70', mm[0]));
    Q(/(AST|ALT|トランスアミナーゼ)[^。、\d]{0,6}(著明|著しく|1000|千)/, mm => { add('ast_alt_pattern', 'gt1000', mm[0]); add('liver_enz', 'elevated', mm[0]); });
    Q(/血圧(が|は)?[^。、\d]{0,2}(低下|低い|低値|測定しにくい|測れない|測定困難)|ショック|低血圧/, mm => add('sbp', 'lt90', mm[0]));
    Q(/血圧(が|は)?[^。、\d]{0,2}(高く|高い|上昇|高値)/, mm => add('sbp', 'gt140', mm[0]));
    Q(/頻脈/, mm => add('hr', '100_120', mm[0])); Q(/徐脈/, mm => add('hr', 'lt60', mm[0]));
    Q(/低体温/, mm => add('temp', 'lt36', mm[0])); Q(/頻呼吸/, mm => add('rr', 'gt24', mm[0])); Q(/低酸素/, mm => add('spo2', 'lt94', mm[0]));
    for (m of text.matchAll(/(?<![\d.])(3[4-9]|4[0-2])(\.\d)?\s*(℃|度)/g)) { const v = parseFloat(m[1] + (m[2] || '')); add('temp', v < 36 ? 'lt36' : v < 37.5 ? 'lt375' : v < 38 ? '375_38' : v < 39 ? '38_39' : 'ge39', m[0]); }
  }
  /* 拡張パックの feature（ext:true）用の語彙をラベルから自動生成 */
  let KW_EXT = null;
  function extKW() {
    if (KW_EXT) return KW_EXT;
    KW_EXT = [];
    const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const MANUAL = { amyloid_background: ['関節リウマチ', '透析', '骨髄腫', '慢性炎症性疾患', '長年の炎症性疾患', 'アミロイド'], nocturnal_sx: [/(夜間|夜中|睡眠中|就寝中)[^。]{0,10}(目が覚め|目を覚ま|覚醒|起き(る|た|て))|夜間覚醒/], groin_bulge: [/(鼠径|大腿|腹壁|臍)部?(が|の|に)?[^。、]{0,4}(膨隆|膨ら|腫瘤|しこり|ふくらみ|腫脹)|(創部|手術創|切開創|瘢痕)[^。、]{0,6}(膨ら|膨隆)|臥位で[^。、]{0,8}(小さく|消失|戻)|(鼠径|大腿|臍|腹壁|白線|半月状線)ヘルニア(?!の既往|の術後|術後|の手術)/], autoimmune_hx: ['膠原病', 'SLE', '全身性エリテマトーデス', 'ループス', '関節リウマチ', '強皮症', '皮膚筋炎', '多発性筋炎', 'シェーグレン', 'MCTD', '混合性結合組織病', '血管炎の既往', '結節性多発動脈炎', 'EGPA', '好酸球性多発血管炎'], thrombophilia_hx: ['抗リン脂質抗体', 'APS', 'プロテインC', 'プロテインS', 'アンチトロンビン', '血栓性素因', '血栓症の既往', 'DVT', '深部静脈血栓', '肺塞栓の既往', '骨髄増殖性', '真性多血症', '本態性血小板血症'], bedridden_psych: ['長期臥床', '寝たきり', '臥床', '施設入所', '認知症', '精神疾患', 'パーキンソン', '統合失調症'], radiation_hx: ['放射線治療', '放射線照射', '照射歴'], cancer_hx: ['癌の既往', 'がんの既往', '担癌', '悪性腫瘍の既往', '化学療法中', /(癌|がん|悪性腫瘍)[^。、]{0,4}(の)?(手術|術後|切除後|既往|治療歴|治療中)/], cirrhosis_hx: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(肝硬変|慢性肝炎|B型肝炎|C型肝炎|慢性肝疾患)(?!像|様)/], dialysis_ckd: ['透析', '腎不全', 'CKD'], opioid_use: ['オピオイド', 'オキシコドン', 'モルヒネ', 'フェンタニル', 'トラマドール'], heartburn_regurg: ['胸やけ', '胸焼け', '呑酸', '逆流症状', /逆流(する|した|感)|吐き戻/, /逆流(が|を)/, /口(へ|に)戻る/], dysphagia: ['嚥下障害', '嚥下痛', '飲み込みにく', 'つかえ', '嚥下困難', '胸のつかえ'], hepatomegaly: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(肝腫大|肝を触知|肝叩打痛|肝(臓)?を\d*横指)/], splenomegaly: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(脾腫|脾を触知|脾(臓)?を触)/], ascites_exam: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(腹水|腹部[^。、]{0,4}波動|shifting|蛙腹)/], leg_edema: [/(下腿|下肢|両足|足|脚)(の|に)?(浮腫|むくみ)|圧痕性浮腫|pitting/], pruritus: ['瘙痒', 'そう痒', 'かゆみ', '掻痒', '痒み'], tenesmus_urgency: ['しぶり腹', '便意切迫', 'テネスムス'], early_satiety_bloating: ['早期飽満', '早期満腹', '食後膨満', 'もたれ', /(少量|少し)[^。、]{0,8}満腹|すぐに満腹|満腹(に)?なる/], carnett_sign: ['Carnett', 'カーネット', /腹筋(を)?(緊張|収縮)[^。]{0,14}(圧痛|痛み)[^。、]{0,6}(弱まらず|変わらず|不変|増強|強く|残)|頭(を|部を)?(上げ|挙上)[^。、]{0,10}(圧痛|痛み)[^。、]{0,6}(残|変わらず|増強)/], sti_risk: ['性感染症', 'STI', '複数パートナー', 'MSM', 'IUD', 'クラミジア', '淋菌', '淋病'], raw_fish_intake: ['生魚', 'サバ', 'イカ', 'アジ', '刺身', '寿司'], pain_fasting_nocturnal: ['空腹時痛', '夜間痛', '空腹時に痛'], pain_relief_leaning_forward: ['前屈で軽減', '前かがみ', '坐位で軽減'], steatorrhea: ['脂肪便', '油っぽい便'], fatigue: ['倦怠感', 'だるさ', '疲労感'], obesity: ['肥満', 'BMI'], subcutaneous_emphysema: ['皮下気腫', 'Hamman'], forceful_vomiting_prior: [/激しく嘔吐|激しい嘔吐|嘔吐(を)?(繰り返|反復)|(数回|何度も|繰り返し)[^。、]{0,4}嘔吐|嘔吐(の)?(直後|後に|した後)/], allergy_hx: ['喘息', 'アトピー', 'アレルギー性鼻炎', 'アレルギー'], new_medication: ['新しく開始', '開始した薬', '漢方', 'サプリ', '健康食品', /新規(の)?(薬|薬剤|内服)|(薬|薬剤|内服)(の)?(開始|変更)(後)?|服用開始|内服開始/], pancreatitis_hx: ['膵炎の既往', '膵炎歴', '高TG', '高トリグリセリド', /膵炎(の)?(既往|歴|後|から|を繰り返)/, '慢性膵炎', /(急性)?膵炎を繰り返/, /膵炎[^。、]{0,6}(から|後)/], diabetes_new_worsening: ['糖尿病の新規発症', '血糖コントロール悪化'], blood_sexual_exposure: ['輸血歴', '刺青', '注射薬物', '性的接触'], eosinophilia: ['好酸球増多', '好酸球'], igg4: ['IgG4'], diarrhea_pattern: ['下痢', '軟便', '水様便'], urine_stool_color: ['尿', '便'], abd_mass: ['腫瘤', '腫瘍を触知', 'しこり'], skin_finding: ['皮疹', '紫斑', '水疱', '紅斑', '色素沈着', 'くも状血管腫', '手掌紅斑'], endocrine_lab: ['TSH', 'コルチゾール', '甲状腺'], menstrual_relation: ['月経', '生理', '排卵'], ingestion_event: ['誤飲', '異物', '服用', '内視鏡'], paracentesis: ['腹水穿刺', 'SAAG'], endoscopy: ['内視鏡', '胃カメラ', 'EGD', 'GIF', 'CF', '大腸カメラ'], cxr: ['胸部X線', '胸部レントゲン', '胸写', 'CXR'] };
    const EXPLICIT = new Set(['kf_ring', 'meckel_scan', 'cervical_os_open', 'aaa_known', 'vaginal_discharge', 'ingestion_event', 'skin_finding', 'flushing', 'paracentesis', 'urine_5hiaa', 'macroglossia', 'proteinuria', 'estrogen_use', 'palpitations', 'catecholamine_high', 'clubbing', 'platypnea', 'hp_positive', 'neuro_sx', 'electrolyte', 'pregnancy_status', 'fobt', 'ck', 'ldh', 'sil2r', 'ammonia', 'ici_use', 'hemolysis_labs', 'endoscopy', 'anal_sx', 'abd_mass', 'urine_stool_color', 'menstrual_relation', 'autoantibodies', 'hepatitis_serology', 'igg4', 'endocrine_lab', 'tumor_marker', 'iron_overload', 'ceruloplasmin_low', 'gastrin_high', 'b12_low', 'porphyrin_urine', 'stool_a1at', 'gastrectomy_hx', 'dyspareunia', 'heart_failure_hx', 'jvd', 'abd_bruit', 'succussion_splash', 'pulse_deficit', 'perianal_disease']);
    const GENERIC = /^(腹部|上腹部|下腹部|骨盤|腫瘤|触知|正常|異常|異常なし|なし|所見|既往|歴|使用|服用|摂取|上昇|低下|陽性|陰性|その他|増多|性状|変化|急性|慢性|検査|血清|末梢|皮膚|神経|症状|パターン|状態|関連|リスク|持続|反復|大量|少量|頻回|軽減|増悪|数時間|数日|以内|新規|最近|一時|治療中|治療歴|状態)$/;
    for (const f of KB().features) {
      if (!f.ext) continue;
      // ラベルは「/」区切りだけを別語とみなす（「・」区切りは1語の一部が一般語になりやすい）。3文字以上、一般語は除外
      const strip = t => t.replace(/（.*?）|\(.*?\)/g, '').trim();
      const stem = t => { const m = t.replace(/(の)?(既往|歴|所見|検査|触知|の使用|使用|摂取)$/, ''); return m.length >= 2 ? m : t; };
      const manual = f.kw || MANUAL[f.id];
      if (EXPLICIT.has(f.id)) continue;
      const terms = manual ? manual.map(t => t instanceof RegExp ? t : t.trim()).filter(Boolean) : strip(f.label).split(/[/／・]/).map(t => stem(t.trim())).filter(t => t.length >= 2 && !GENERIC.test(t));
      if (!terms.length) continue;
      const fre = terms.map(t => t instanceof RegExp ? t.source : esc(t)).join('|');
      if (f.values) {
        // 値付き: 項目語と値語の両方が同じ文にあるときだけ（値語だけでは反応しない）
        for (const v of f.values) { const vt = strip(v.label).split(/[/／、・]/).map(t => t.trim()).filter(t => t.length >= 2 && !GENERIC.test(t)); if (vt.length) KW_EXT.push([f.id, vt.map(esc).join('|'), v.code, fre]); }
      } else KW_EXT.push([f.id, fre, null]);
    }
    return KW_EXT;
  }
  function local(text) {
    const kb = KB(); const items = []; const seen = new Set();
    let curS = -1;
    const add = (fid, value, quote, status, extra) => { const key = fid + '|' + (value || '') + '|' + (status || 'present'); if (seen.has(key)) return; const f = kb.feature[fid]; if (!f) return;
      // 値が1つだけの項目（嘔吐・下痢・CRP など）は、同じ文で先に立った具体的な値を後の一般語で上書きしない（腹痛の部位は従来どおり）
      if (!f.multi && f.values && fid !== 'abd_pain' && (status || 'present') === 'present' && items.some(i => i.feature_id === fid && i._s === curS && i.status === 'present')) return;
      seen.add(key);
      items.push(Object.assign({ _s: curS, feature_id: fid, status: status || 'present', value_code: (status || 'present') === 'present' || (status === 'absent' && f.values) ? value : null, severity: null, time_context: { elapsed_bucket: f.anchor === 'none' ? null : 'unknown', trend: 'unknown' }, quote: quote || '' }, extra || {})); };
    const sentences = text.split(/[。\n．]/).map(s => s.trim()).filter(Boolean);
    for (const s of sentences) {
      curS++;
      const tb = bucketTime(s), tr = trendOf(s);
      // 腹痛（部位）
      if (/痛/.test(s.replace(/圧痛|叩打痛|反跳痛|移動痛|放散痛|無痛|排便痛|性交痛|嚥下痛/g, ''))) {
        let any = false;
        for (const [code, re] of LOC) { const m = s.match(new RegExp(re)); if (m) { any = true; const neg = negated(s, m.index, m[0].length) && /痛.{0,4}(なし|ない|なく|乏し)/.test(s); add('abd_pain', code, s.slice(0, 60), neg ? 'absent' : 'present', { severity: sevOf(s), time_context: { elapsed_bucket: tb || 'unknown', trend: tr } }); } }
        if (!any && /腹痛|お腹が痛|腹が痛/.test(s)) add('abd_pain', 'diffuse', s.slice(0, 60), /腹痛(は|も|が)?(なし|ない|なく|乏し|認めない|認めず)/.test(s) ? 'absent' : 'present', { severity: sevOf(s), time_context: { elapsed_bucket: tb || 'unknown', trend: tr } });
      }
      if (/(腹部|腹)(は|に)?[^。、]{0,8}圧痛(は|が|も)?(ない|なく|なし|認めない|認めず)|^圧痛(は|が|も)?(ない|なく|なし)|、圧痛(は|が|も)?(ない|なく|なし)|深部圧痛(は|が)?(ない|なく)/.test(s) && !/(右下|右上|左下|左上|心窩|季肋|下腹|上腹)[^。、]{0,4}(部)?(に|の)?[^。、]{0,4}圧痛(が|を)?(あ|認め)/.test(s))
        for (const t of ['tender_rlq', 'tender_ruq', 'tender_llq', 'tender_epi']) add(t, null, s.slice(0, 60), 'absent');
      if (/無痛性|痛み(の|を)?(ない|伴わない|なし)|痛み(の|に|が|は)?乏し|腹痛(は|を)?伴わ/.test(s)) add('abd_pain', null, s.slice(0, 60), 'absent', { time_context: { elapsed_bucket: tb || 'unknown', trend: 'unknown' } });
      for (const [fid, re, val, fre] of KW.concat(extKW())) {
        if (fre && !new RegExp(fre).test(s)) continue; // 値付き拡張項目: 項目語が同じ文に必要
        const m = s.match(new RegExp(re)); if (!m) continue;
        const f = kb.feature[fid]; const neg = negated(s, m.index, m[0].length);
        const extra = { time_context: { elapsed_bucket: f.anchor === 'none' ? null : (tb || 'unknown'), trend: (f.type === 'chief_complaint' || f.type === 'symptom') ? tr : 'unknown' } };
        if (f.sev && !neg) extra.severity = sevOf(s);
        if (f.values && !neg && val === null) continue;
        if (f.multi && f.type === 'imaging' && neg) continue; // 画像の「〜なし」は所見として登録しない（異常なし は normal で扱う）。症状系の multi は値付き absent で登録
        add(fid, f.values ? val : null, s.slice(0, 60), neg ? 'absent' : 'present', extra);
      }
      // 内視鏡の腫瘍所見は臓器で上部/下部に分ける（大腸・小腸などの語が同じ文にあれば下部）
      if (/大腸|結腸|直腸|盲腸|回腸|空腸|小腸|S状|回盲|肛門|CF|カプセル/.test(s)) for (const it of items) if (it._s === curS && it.feature_id === 'endoscopy' && it.value_code === 'tumor') it.value_code = 'tumor_lower';
      numbers(s, (fid, val, q, st) => add(fid, val, q, st || 'present', { time_context: { elapsed_bucket: tb || 'unknown', trend: 'unknown' } }));
    }
    // 文脈
    const ctx = {}; const am = text.match(/(\d{1,3})\s*歳/) || text.match(/(\d)0代/);
    if (am) { const n = am[0].includes('代') ? parseInt(am[1], 10) * 10 : parseInt(am[1], 10); const b = ageBand(n); if (b) ctx.age_band = b.code; }
    else { const bm = text.match(/(18-29歳|30代|40代|50代|60代|70代|80歳以上|18歳未満)/); if (bm) { const b = AGE_BANDS.find(x => x[3] === bm[1]); if (b) ctx.age_band = b[2]; } }
    if (/女性|女児|婦人|妊/.test(text)) ctx.sex = 'female'; else if (/男性|男児/.test(text)) ctx.sex = 'male';
    if (/妊娠中|妊婦|妊娠\s*\d+\s*週/.test(text)) ctx.pregnancy = 'confirmed'; else if (/妊娠(の)?可能性(は)?(なし|ない|否定)|閉経|避妊/.test(text)) ctx.pregnancy = 'no'; else if (/妊娠(の)?可能性(あり|ある)/.test(text)) ctx.pregnancy = 'possible';
    for (const i of items) delete i._s;
    return { ok: true, provider: 'local', items, context: ctx, unmapped: [] };
  }

  /* ---------------- 合成: LLM 優先、失敗時ローカル。数値項目はローカル結果で補完 ---------------- */
  async function extract(rawText, opts) {
    opts = opts || {};
    const sc = scrub(rawText);
    const loc = local(sc.text);
    if (!opts.useLLM || !LLM.ready()) return Object.assign(loc, { scrubbed: sc, llm: null, fallback: !opts.useLLM ? 'llm_off' : 'no_key' });
    try {
      const out = await LLM.extract(sc.text);
      const have = new Set(out.items.map(i => i.feature_id + '|' + (i.value_code || '')));
      for (const it of loc.items) if (['vital', 'lab'].includes(KB().feature[it.feature_id].type) && !have.has(it.feature_id + '|' + (it.value_code || ''))) out.items.push(it);
      out.context = Object.assign({}, loc.context, out.context);
      return Object.assign(out, { scrubbed: sc, llm: { ok: true, model: out.model, latency: out.latency, usage: out.usage } });
    } catch (e) {
      return Object.assign(loc, { scrubbed: sc, llm: { ok: false, error: String(e && e.message || e) }, fallback: 'llm_error' });
    }
  }
  DDX.Extract = { scrub, local, extract, LLM, validate, catalogText, ageBand, SYSTEM, TOOL };
})(typeof window !== 'undefined' ? window : globalThis);
