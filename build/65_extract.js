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
        if (/haiku-4-5/.test(LLM.config.model)) { /* no effort */ } else body.output_config = { effort: 'low' };
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
  const NEG = '(?:なし|無し|ない|認めず|認めない|認められず|否定|陰性|\\(-\\)|（-）|−|マイナス|みられず|見られず|はない|指摘できず|指摘されず|指摘なし|描出されず|検出されず|ありません)';
  const LOC = [['rlq', '右下腹'], ['ruq', '右上腹|右季肋'], ['epi', '心窩|みぞおち|(?<![右左])上腹部'], ['llq', '左下腹'], ['luq', '左上腹|左季肋'], ['umb', '臍|へそ|おへそ'], ['diffuse', '腹部全体|全体的|びまん|お腹全体|腹全体'], ['supra', '(?<![右左])下腹部|恥骨上'], ['flank_r', '右側腹|右背|右腰|右CVA'], ['flank_l', '左側腹|左背|左腰|左CVA']];
  const KW = [ // [feature_id, regex, value|null]
    ['diarrhea', '水様(便|下痢)', 'watery'], ['diarrhea', '血性下痢|血便を伴う下痢', 'bloody'], ['diarrhea', '粘液(便|性下痢)', 'mucous'], ['diarrhea', '下痢|軟便', 'watery'],
    ['vomiting', '胆汁性(嘔吐)?|緑色の嘔吐', 'bilious'], ['vomiting', '吐血', 'hematemesis'], ['vomiting', 'コーヒー残渣', 'coffee_ground'], ['vomiting', '嘔吐|吐いた|吐く', 'nonbilious'],
    ['nausea', '嘔気|吐き気|悪心|むかつき', null], ['anorexia', '食欲(低下|不振|なし)|食思不振|食べられない', null], ['fever_sub', '発熱|熱感|悪寒|寒気|熱がある', null],
    ['obstipation', '排ガス(停止|なし)|排便(停止|なし|がない)|ガスが出ない|便が出ない', null], ['gi_bleed', '黒色便|タール便|メレナ', 'melena'], ['gi_bleed', '血便|下血', 'hematochezia'],
    ['dysuria', '排尿時痛|排尿痛|頻尿|残尿感', null], ['vaginal_bleeding', '不正(性器)?出血|性器出血', null], ['jaundice_sub', '黄疸|眼球黄染', null], ['weight_loss', '体重(減少|が減)', null],
    ['chest_sx', '胸痛|胸が苦しい|呼吸苦|息切れ|冷汗', null], ['syncope', '失神|気を失|前失神|意識消失', null], ['sick_contact_food', '周囲に同(様|じ)症状|家族も|食中毒|生もの|生肉|生牡蠣|生ガキ', null], ['scrotal_pain', '陰嚢(の)?痛|精巣(の)?痛|睾丸', null],
    ['pain_onset_char', '突然|急に|突発', 'sudden'], ['pain_onset_char', '徐々に|だんだん|次第に', 'gradual'],
    ['pain_char', '食後(に|の)?(痛|増悪|悪化)|食事(で|後)(痛|増悪)', 'postprandial'], ['pain_char', '疝痛|波がある|間欠的|差し込む', 'colicky'], ['pain_char', '持続(性|的)(の)?痛|ずっと痛', 'constant'], ['pain_char', '(臍(周囲)?|心窩部|みぞおち|上腹部)から右下|右下腹部(へ|に)移動|痛み(が|の)?移動|移動性(の)?(痛|疼痛)', 'migrating_rlq'], ['pain_char', '背中(に|へ)(放散|抜け)|背部(へ|に)放散|背部痛を伴', 'radiate_back'], ['pain_char', '肩(甲部)?(に|へ)(放散|抜け)', 'radiate_shoulder'], ['pain_char', '鼠径(部)?(に|へ)(放散|抜け)|陰部(に|へ)放散', 'radiate_groin'],
    ['pain_worse_moving', '体動で(増悪|悪化)|動くと痛|振動で痛|歩くと痛|咳で痛', null],
    ['lmp_delayed', '月経(が)?(遅れ|遅延)|生理が(遅れ|来て)', null], ['prior_abd_surgery', '開腹|腹部手術|手術歴|(虫垂|胆嚢|胃|大腸|子宮)(切除|摘出)|帝王切開', null], ['alcohol_heavy', '大酒|多量飲酒|アルコール(多飲|依存)|毎日飲酒|飲酒歴', null],
    ['nsaid_aspirin', 'NSAID|ロキソ|ロキソニン|イブプロフェン|ボルタレン|アスピリン|バファリン|鎮痛薬', null], ['anticoag', '抗凝固|ワーファリン|ワルファリン|DOAC|エリキュース|イグザレルト|リクシアナ|プラザキサ|抗血小板|クロピドグレル', null],
    ['recent_abx', '抗菌薬|抗生剤|抗生物質', null], ['hospitalized_recent', '最近(の)?入院|入院歴|施設入所|退院後', null], ['travel', '海外渡航|渡航歴|旅行から', null],
    ['af_vascular', '心房細動|AF|Af|動脈硬化|閉塞性動脈|心筋梗塞の既往|脳梗塞の既往', null], ['cv_risk', '高血圧|脂質異常|高脂血症|喫煙|タバコ', null], ['diabetes', '糖尿病|DM|インスリン', null],
    ['immunosupp', 'ステロイド|免疫抑制|化学療法|抗がん剤|化療', null], ['gallstone_hx', '胆石', null], ['ibd_hx', '潰瘍性大腸炎|クローン|Crohn|IBD|炎症性腸疾患', null], ['divertic_hx', '憩室.{0,4}(既往|歴)|憩室症', null], ['pud_hx', '(胃|十二指腸)潰瘍(の)?(既往|歴)|潰瘍歴', null], ['hernia_hx', 'ヘルニア(の)?既往|ヘルニア歴|脱腸', null], ['similar_episodes', '以前(に)?も同(様|じ)|同様の発作|繰り返し', null],
    ['rebound_guarding', '反跳痛|Blumberg|ブルンベルグ|筋性防御|腹膜刺激', null], ['rigidity', '板状硬', null], ['tender_rlq', 'McBurney|マックバーニー|右下腹部(の|に)?圧痛', null], ['tender_ruq', '右上腹部(の|に)?圧痛|右季肋部(の|に)?圧痛', null], ['murphy', 'Murphy|マーフィー', null],
    ['tender_llq', '左下腹部(の|に)?圧痛', null], ['tender_epi', '心窩部(の|に)?圧痛|(?<![右左])上腹部(の|に)?圧痛', null], ['distension', '腹部膨満|(?<!(腹壁|鼠径|大腿|臍)部?(の)?)膨隆|お腹が張', null],
    ['bowel_sounds', '腸(蠕動)?音(の)?亢進|金属音', 'hyper'], ['bowel_sounds', '腸(蠕動)?音(の)?(減弱|低下)', 'hypo'], ['bowel_sounds', '腸(蠕動)?音(の)?消失', 'absent'], ['bowel_sounds', '腸(蠕動)?音(は)?正常', 'normal'],
    ['cva_tender', 'CVA|肋骨脊柱角|(?<!肝(臓)?(の)?)叩打痛', null], ['pulsatile_mass', '拍動性(の)?腫瘤|拍動する', null], ['hernia_irreducible', '還納(不能|できない)|嵌頓', null], ['pain_disproportion', '所見に比して|所見に乏しい(のに|が)|痛みが強い割に', null],
    ['psoas_obturator', 'psoas|腸腰筋徴候|閉鎖筋徴候|obturator', null], ['dehydration_signs', '脱水|口腔(内)?乾燥|ツルゴール|皮膚の張り', null], ['rectal_blood', '直腸診で(血|出血)|直腸診.*血', null], ['adnexal_tender', '付属器(の)?圧痛|子宮頸部移動痛|CMT', null],
    ['scrotal_exam', '陰嚢(の)?(腫脹|圧痛|腫大)|精巣(の)?(腫脹|圧痛)', 'tender_swollen'],
    // 神経症状（拡張項目 neuro_sx）: 値ごとに明示ルール
    ['neuro_sx', '末梢神経障害|ニューロパチー|多発(性)?(単)?神経炎|(四肢|手足|両手|両足|手|足)(の|に)?(しびれ|痺れ)|しびれ|痺れ|知覚(障害|鈍麻)|感覚(障害|鈍麻)|筋力低下|脱力|下垂足|手袋靴下|(四肢|手|足|下肢|上肢)(の)?麻痺', 'paresthesia_weakness'],
    ['neuro_sx', '頭痛|項部硬直|髄膜刺激', 'headache'], ['neuro_sx', '錯乱|失調|眼球運動障害|眼振', 'confusion_ataxia'],
    ['neuro_sx', 'めまい|眩暈|回転性', 'vertigo'], ['neuro_sx', '眼痛|視力(低下|障害)|霧視|かすみ|視野', 'eye_pain_visual'], ['neuro_sx', '局所神経|片麻痺|構音障害|失語|顔面麻痺', 'focal_deficit'], ['neuro_sx', '神経(学的)?(症状|所見|異常|脱落)', null],
 ['skin_pallor_cold', '末梢冷感|冷感|蒼白|顔色不良', null], ['consciousness', '意識(障害|レベル低下|混濁|変容)|JCS|GCS\\s*1[0-4]|傾眠|せん妄', 'altered'], ['consciousness', '意識(清明|は清明|レベル清明)', 'alert'],
    ['hcg', '(妊娠反応|hCG|HCG)\\s*(陽性|\\(\\+\\)|（\\+）|\\+)', 'pos'], ['hcg', '(妊娠反応|hCG|HCG)\\s*(陰性|\\(-\\)|（-）|-)', 'neg'],
    ['urinalysis', '(血尿|(?<!便)潜血).*(膿尿|白血球)|(膿尿|白血球).*(血尿|(?<!便)潜血)', 'both'], ['urinalysis', '血尿|(?<!便)潜血', 'hematuria'], ['urinalysis', '膿尿|尿中白血球|尿WBC', 'pyuria'], ['urinalysis', '尿(検査|所見)(は)?正常|尿所見なし', 'normal'],
    ['troponin', 'トロポニン\\s*(陽性|上昇|\\+)', 'pos'], ['troponin', 'トロポニン\\s*(陰性|正常|-)', 'neg'], ['ecg', '(心電図|ECG).*(ST|虚血|T波)', 'ischemic'], ['ecg', '(心電図|ECG).*(心房細動|AF|Af)', 'af'], ['ecg', '(心電図|ECG)(は|に)?(正常|異常なし)', 'normal'],
    ['lipase', '(?<!(腹水|穿刺液|ドレーン|排液)[^。]{0,8})(リパーゼ|アミラーゼ).*(3倍|著明|高値|上昇)', 'ge3x'], ['lipase', '(?<!(腹水|穿刺液|ドレーン|排液)[^。]{0,8})(リパーゼ|アミラーゼ).*(軽度上昇|やや高)', 'lt3x'], ['lipase', '(?<!(腹水|穿刺液|ドレーン|排液)[^。]{0,8})(リパーゼ|アミラーゼ).*(正常|基準内)', 'normal'],
    ['liver_enz', '(AST|ALT|肝酵素|トランスアミナーゼ).*(上昇|高値)', 'elevated'], ['liver_enz', '(AST|ALT|肝酵素).*(正常|基準内)', 'normal'], ['bili', '(ビリルビン|T-?Bil).*(上昇|高値)', 'elevated'], ['bili', '(ビリルビン|T-?Bil).*(正常|基準内)', 'normal'],
    ['alp_ggt', '(ALP|γ-?GTP|GGT).*(上昇|高値)', 'elevated'], ['renal', '(Cre|クレアチニン|BUN|腎機能).*(上昇|高値|悪化|障害)', 'elevated'], ['hb', '(Hb|ヘモグロビン|貧血).*(低下|進行)|貧血あり|貧血', 'low'],
    ['acidosis', '代謝性アシドーシス|アシドーシス', 'metabolic'], ['ddimer', 'D-?ダイマー\\s*(上昇|高値|陽性)', 'elevated'], ['ddimer', 'D-?ダイマー\\s*(正常|陰性)', 'normal'],
    ['stool_test', '(CD|C\\.?\\s?diff|ディフィシル).*(陽性|\\+)', 'cdiff_pos'], ['stool_test', '便培養.*(陽性|検出)', 'culture_pos'], ['stool_test', '(便培養|CDトキシン).*(陰性)', 'neg'],
    ['xray', '(?<!CT[^。]*)(?<!エコー[^。]*)(?<!超音波[^。]*)(free ?air|フリーエア|遊離ガス)', 'free_air'], ['xray', '(?<!CT[^。]*)(?<!エコー[^。]*)(?<!超音波[^。]*)(鏡面像|ニボー|niveau)', 'air_fluid'], ['xray', '(?<!CT[^。]*)(?<!エコー[^。]*)(?<!超音波[^。]*)(腸管|小腸)(の)?拡張', 'dilated_loops'],
    ['us', '(エコー|超音波|US).*(虫垂(腫大|腫脹)|虫垂炎)', 'appendix'], ['us', '(エコー|超音波|US).*(胆嚢(壁)?肥厚|胆嚢腫大|胆嚢結石|sonographic)', 'gb'], ['us', '(エコー|超音波|US).*(総胆管拡張|胆管拡張)', 'cbd_dilated'], ['us', '(エコー|超音波|US).*(腹水|液体貯留|ダグラス窩)', 'free_fluid'], ['us', '(エコー|超音波|US).*水腎', 'hydro'], ['us', '(エコー|超音波|US).*(大動脈瘤|AAA)', 'aaa'], ['us', '(エコー|超音波|US).*(付属器|卵巣)(腫大|腫瘤)', 'adnexal'], ['us', '(エコー|超音波|US)(は|で)(異常なし|正常)', 'normal'],
    ['ct', 'CT.*虫垂', 'appendicitis'], ['ct', 'CT.*憩室炎', 'diverticulitis'], ['ct', 'CT.*(free ?air|遊離ガス|フリーエア|腹腔内(遊離)?ガス)', 'free_air'],
    ['ct', 'CT.*(腸閉塞|イレウス|SBO|閉塞起点|(小腸|腸管)(の)?拡張|ニボー|鏡面像|niveau)', 'sbo'],
    ['ct', 'CT.*(上腸間膜動脈症候群|SMA症候群|十二指腸(の)?(圧排|狭窄|通過障害)|大動脈.{0,6}上腸間膜動脈.{0,6}角)', 'duodenal_compression'], ['ct', '(?![^。]*(症候群|十二指腸|の角|角狭小|角が))CT.*(腸管虚血|壁造影不良|造影不良|造影欠損|SMA|上腸間膜動脈|腸間膜動脈|門脈ガス|腸管気腫|(?<!(門脈|静脈|SMV)(内)?(の)?)血栓)', 'ischemia'], ['ct', 'CT.*膵(炎|腫大|周囲)', 'pancreatitis'], ['ct', 'CT.*(大動脈瘤|解離|AAA|フラップ)', 'aortic'],
    ['ct', 'CT.*(尿管結石|尿路結石|腎結石|(?<![胆嚢胆])結石)', 'stone'], ['ct', 'CT.*(大腸炎|腸炎|(大腸|結腸|S状結腸|直腸|盲腸|上行結腸|横行結腸|下行結腸)[^。]{0,6}壁(の)?肥厚)', 'colitis'], ['ct', 'CT.*(胆嚢炎|胆管炎|胆嚢壁肥厚|胆嚢周囲)', 'cholecystitis'], ['ct', 'CT.*膿瘍', 'abscess'], ['ct', 'CT.*(嵌頓|(?<!内)ヘルニア)', 'hernia'], ['ct', 'CT.*(付属器|卵巣)', 'adnexal'], ['ct', 'CT.*(軸捻|捻転)', 'volvulus'],
    ['ct', 'CT(は|で|では|上|:|：)?\\s*(明らかな)?(異常なし|異常所見なし|正常|特記所見なし|特記すべき所見なし|有意な所見なし)', 'normal'],
    ['gallstone_hx', '(CT|エコー|超音波|US).*(胆嚢結石|胆石)', null],
    // 腹部CT（ct_other / ct_wall_mass / 肝胆膵画像を集約した値。MRI/MRCP の同じ所見もここ）
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((肝|肝臓)(内)?(の)?(腫瘤|腫瘍|SOL|占拠性病変|結節)|肝(転移|細胞癌)|HCC)', 'liver_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(脂肪肝|肝(の)?脂肪(沈着|化))', 'fatty_liver'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(肝硬変|肝(表面|辺縁)(の)?(凹凸|不整|鈍)|肝(の)?萎縮)', 'cirrhotic_liver'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((肝内|肝外|総)?胆管(の)?(拡張|狭窄))', 'biliary_dilation'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(胆嚢(の)?壁(の)?肥厚|胆嚢(の)?(腫瘤|腫瘍|隆起))', 'gb_wall_thick'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(膵(臓)?(の)?(腫瘤|腫瘍|癌|低吸収)|(主)?膵管(の)?拡張)', 'pancreatic_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(膵(の)?嚢胞|IPMN|嚢胞性膵)', 'pancreatic_cyst'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(びまん性(の)?膵腫大|ソーセージ様|capsule-like)', 'diffuse_pancreas_swelling'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(膵(石|石灰化)|膵管(の)?不整)', 'chronic_pancreatitis'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(門脈(内)?(の)?(血栓|閉塞)|(上)?腸間膜静脈(内)?(の)?血栓|SMV(内)?(の)?血栓)', 'pvt'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腹水|腹腔内(の)?液体貯留)', 'ascites'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(胃(の)?壁(の)?肥厚|胃壁肥厚)', 'gastric_wall_thick'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(脾梗塞)', 'splenic_infarct'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(脾(臓)?(の)?(破裂|損傷)|脾動脈瘤破裂)', 'splenic_rupture'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(肝脾腫|脾腫|肝腫大)', 'hepatosplenomegaly'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腎梗塞|腎(の)?楔状(の)?造影不良)', 'renal_infarct'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((後腹膜|腹腔内|腸間膜)(の)?(腫瘤|腫瘍))', 'retro_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腸管(壁)?(内)?気腫|腸管壁内(の)?ガス|pneumatosis)', 'pneumatosis'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腸腰筋(の)?(膿瘍|腫大))', 'psoas_abscess'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(腹直筋鞘(内)?血腫|腹壁(の)?血腫)', 'wall_hematoma'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((腸)?重積|target sign|ターゲットサイン)', 'intussusception'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((腸管|小腸|大腸|結腸|S状結腸|直腸|盲腸|上行結腸|横行結腸|下行結腸)[^。]{0,6}壁(の)?肥厚|腸管壁肥厚)', 'wall_thick'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*((腸管|小腸|大腸|結腸|S状結腸|直腸|盲腸)[^。]{0,6}(腫瘤|腫瘍|全周性(の)?(壁肥厚|狭窄)|apple core))', 'bowel_mass'],
    ['ct', '(CT|ＣＴ|MRI|MRCP)[^。]*(内ヘルニア|傍十二指腸|網嚢孔|closed ?loop|クローズドループ|beak sign)', 'internal_hernia'],
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
  ];
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
  function negated(text, idx, len) { const after = text.slice(idx + len, idx + len + 8); const before = text.slice(Math.max(0, idx - 4), idx); return new RegExp('^\\s*(は|も|の)?\\s*' + NEG).test(after) || /(なし|無|否定)$/.test(before); }
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
    for (m of text.matchAll(/(?:血糖|BS|Glu|グルコース)\s*[:：=]?\s*(\d{2,4})/gi)) { const v = +m[1]; add('glucose', v > 250 ? 'gt250' : 'normal', m[0]); }
    for (m of text.matchAll(/(?:Hb|ヘモグロビン)\s*[:：=]?\s*(\d{1,2}(?:\.\d+)?)/g)) { const v = parseFloat(m[1]); add('hb', v < 11 ? 'low' : 'normal', m[0]); }
    // 検査値パネルと同じ変換（DDX.LABS.resolve）。AST と ALT が同じ文にあればパターンも出る
    if (DDX.LABS && DDX.LABS.resolve) {
      const LV = {}, pick = (id, re, f) => { const mm = text.match(re); if (mm) { let v = parseFloat(mm[1]); if (f) v = f(v, mm); if (v >= 0) LV[id] = v; } };
      pick('na', /(?<![A-Za-z])Na\s*[:：=]?\s*(1\d{2})(?!\d)/); pick('k', /(?<![A-Za-z])K\s*[:：=]?\s*(\d(?:\.\d+)?)(?![\d.])/); pick('ca', /(?<![A-Za-z])Ca\s*[:：=]?\s*(\d{1,2}(?:\.\d+)?)(?![\d.\-])/);
      pick('ck', /(?<![A-Za-z])C(?:P)?K(?!-?MB)\s*[:：=]?\s*(\d{2,6})/); pick('ldh', /(?<![A-Za-z])LDH?\s*[:：=]?\s*(\d{2,5})/); pick('nh3', /(?:NH3|NH₃|アンモニア)\s*[:：=]?\s*(\d{2,4})/);
      pick('plt', /(?:Plt|PLT|血小板)\s*[:：=]?\s*(\d+(?:\.\d+)?)\s*(万)?/, (v, mm) => mm[2] ? v : DDX.LABS.byId.plt.norm(v));
      pick('ast', /(?<![A-Za-z])(?:AST|GOT)\s*[:：=]?\s*(\d{1,5})/); pick('alt', /(?<![A-Za-z])(?:ALT|GPT)\s*[:：=]?\s*(\d{1,5})/);
      for (const x of DDX.LABS.resolve(LV, {})) add(x.f, x.code, Object.keys(LV).join('/'), x.status);
    }
    for (m of text.matchAll(/妊娠\s*(\d{1,2})\s*週/g)) add('pregnancy_status', +m[1] < 14 ? 'first_tri' : 'late', m[0]);
  }
  /* 拡張パックの feature（ext:true）用の語彙をラベルから自動生成 */
  let KW_EXT = null;
  function extKW() {
    if (KW_EXT) return KW_EXT;
    KW_EXT = [];
    const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const MANUAL = { nocturnal_sx: [/(夜間|夜中|睡眠中|就寝中)[^。]{0,10}(目が覚め|目を覚ま|覚醒|起き(る|た|て))|夜間覚醒/], groin_bulge: [/(鼠径|大腿|腹壁|臍)部?(の|に)?(膨隆|腫瘤|しこり|ふくらみ|腫脹)|(鼠径|大腿|臍|腹壁|白線|半月状線)ヘルニア(?!の既往|の術後|術後|の手術)/], autoimmune_hx: ['膠原病', 'SLE', '全身性エリテマトーデス', 'ループス', '関節リウマチ', '強皮症', '皮膚筋炎', '多発性筋炎', 'シェーグレン', 'MCTD', '混合性結合組織病', '血管炎の既往', '結節性多発動脈炎', 'EGPA', '好酸球性多発血管炎'], thrombophilia_hx: ['抗リン脂質抗体', 'APS', 'プロテインC', 'プロテインS', 'アンチトロンビン', '血栓性素因', '凝固異常', '血栓症の既往', 'DVT', '深部静脈血栓', '肺塞栓の既往', '骨髄増殖性', '真性多血症', '本態性血小板血症', 'エストロゲン', '経口避妊薬', 'ピル'], bedridden_psych: ['長期臥床', '寝たきり', '臥床', '施設入所', '認知症', '精神疾患', 'パーキンソン', '統合失調症'], radiation_hx: ['放射線治療', '放射線照射', '照射歴'], cancer_hx: ['癌の既往', 'がんの既往', '担癌', '悪性腫瘍の既往', '化学療法中'], cirrhosis_hx: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(肝硬変|慢性肝炎|B型肝炎|C型肝炎|慢性肝疾患)(?!像|様)/], dialysis_ckd: ['透析', '腎不全', 'CKD'], opioid_use: ['オピオイド', 'オキシコドン', 'モルヒネ', 'フェンタニル', 'トラマドール'], heartburn_regurg: ['胸やけ', '胸焼け', '呑酸', '逆流症状'], dysphagia: ['嚥下障害', '嚥下痛', '飲み込みにくい', 'つかえ'], hepatomegaly: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(肝腫大|肝を触知|肝叩打痛|肝(臓)?を\d*横指)/], splenomegaly: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(脾腫|脾を触知|脾(臓)?を触)/], ascites_exam: [/(?<!(CT|ＣＴ|エコー|超音波|US|MRI|MRCP)[^。]*)(腹水|波動|shifting|蛙腹)/], leg_edema: [/(下腿|下肢|両足|足|脚)(の|に)?(浮腫|むくみ)|圧痕性浮腫|pitting/], pruritus: ['瘙痒', 'そう痒', 'かゆみ'], tenesmus_urgency: ['しぶり腹', '便意切迫', 'テネスムス'], early_satiety_bloating: ['早期飽満', '早期満腹', '食後膨満', 'もたれ'], carnett_sign: ['Carnett', 'カーネット'], sti_risk: ['性感染症', 'STI', '複数パートナー', 'MSM', 'IUD'], raw_fish_intake: ['生魚', 'サバ', 'イカ', 'アジ', '刺身', '寿司'], pain_fasting_nocturnal: ['空腹時痛', '夜間痛', '空腹時に痛'], pain_relief_leaning_forward: ['前屈で軽減', '前かがみ', '坐位で軽減'], steatorrhea: ['脂肪便', '油っぽい便'], fatigue: ['倦怠感', 'だるさ', '疲労感'], obesity: ['肥満', 'BMI'], subcutaneous_emphysema: ['皮下気腫', 'Hamman'], forceful_vomiting_prior: ['激しい嘔吐の後', '嘔吐直後'], allergy_hx: ['喘息', 'アトピー', 'アレルギー性鼻炎', 'アレルギー'], new_medication: ['新しく開始', '開始した薬', '漢方', 'サプリ', '健康食品'], pancreatitis_hx: ['膵炎の既往', '膵炎歴', '高TG', '高トリグリセリド'], diabetes_new_worsening: ['糖尿病の新規発症', '血糖コントロール悪化'], blood_sexual_exposure: ['輸血歴', '刺青', '注射薬物', '性的接触'], eosinophilia: ['好酸球増多', '好酸球'], igg4: ['IgG4'], diarrhea_pattern: ['下痢', '便'], urine_stool_color: ['尿', '便'], abd_mass: ['腫瘤', '腫瘍を触知', 'しこり'], skin_finding: ['皮疹', '紫斑', '水疱', '紅斑', '色素沈着', 'くも状血管腫', '手掌紅斑'], endocrine_lab: ['TSH', 'コルチゾール', '甲状腺'], menstrual_relation: ['月経', '生理', '排卵'], ingestion_event: ['誤飲', '異物', '服用', '内視鏡'], paracentesis: ['腹水穿刺', 'SAAG'], endoscopy: ['内視鏡', '胃カメラ', 'EGD', 'GIF', 'CF', '大腸カメラ'], cxr: ['胸部X線', '胸部レントゲン', '胸写', 'CXR'] };
    const EXPLICIT = new Set(['neuro_sx', 'electrolyte', 'pregnancy_status', 'fobt', 'ck', 'ldh', 'sil2r', 'ammonia', 'ici_use', 'hemolysis_labs']);
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
    const add = (fid, value, quote, status, extra) => { const key = fid + '|' + (value || '') + '|' + (status || 'present'); if (seen.has(key)) return; seen.add(key); const f = kb.feature[fid]; if (!f) return;
      items.push(Object.assign({ feature_id: fid, status: status || 'present', value_code: (status || 'present') === 'present' || (status === 'absent' && f.values) ? value : null, severity: null, time_context: { elapsed_bucket: f.anchor === 'none' ? null : 'unknown', trend: 'unknown' }, quote: quote || '' }, extra || {})); };
    const sentences = text.split(/[。\n．]/).map(s => s.trim()).filter(Boolean);
    for (const s of sentences) {
      const tb = bucketTime(s), tr = trendOf(s);
      // 腹痛（部位）
      if (/痛/.test(s.replace(/圧痛|叩打痛|反跳痛|移動痛|放散痛|無痛/g, ''))) {
        let any = false;
        for (const [code, re] of LOC) { const m = s.match(new RegExp(re)); if (m) { any = true; const neg = negated(s, m.index, m[0].length) && /痛.{0,4}(なし|ない)/.test(s); add('abd_pain', code, s.slice(0, 60), neg ? 'absent' : 'present', { severity: sevOf(s), time_context: { elapsed_bucket: tb || 'unknown', trend: tr } }); } }
        if (!any && /腹痛|お腹が痛|腹が痛/.test(s)) add('abd_pain', 'diffuse', s.slice(0, 60), /腹痛(は|も)?(なし|ない)/.test(s) ? 'absent' : 'present', { severity: sevOf(s), time_context: { elapsed_bucket: tb || 'unknown', trend: tr } });
      }
      if (/無痛性|痛み(の|を)?(ない|伴わない|なし)|腹痛(は|を)?伴わ/.test(s)) add('abd_pain', null, s.slice(0, 60), 'absent', { time_context: { elapsed_bucket: tb || 'unknown', trend: 'unknown' } });
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
      numbers(s, (fid, val, q, st) => add(fid, val, q, st || 'present', { time_context: { elapsed_bucket: tb || 'unknown', trend: 'unknown' } }));
    }
    // 文脈
    const ctx = {}; const am = text.match(/(\d{1,3})\s*歳/) || text.match(/(\d)0代/);
    if (am) { const n = am[0].includes('代') ? parseInt(am[1], 10) * 10 : parseInt(am[1], 10); const b = ageBand(n); if (b) ctx.age_band = b.code; }
    else { const bm = text.match(/(18-29歳|30代|40代|50代|60代|70代|80歳以上|18歳未満)/); if (bm) { const b = AGE_BANDS.find(x => x[3] === bm[1]); if (b) ctx.age_band = b[2]; } }
    if (/女性|女児|婦人|妊/.test(text)) ctx.sex = 'female'; else if (/男性|男児/.test(text)) ctx.sex = 'male';
    if (/妊娠中|妊婦|妊娠\s*\d+\s*週/.test(text)) ctx.pregnancy = 'confirmed'; else if (/妊娠(の)?可能性(は)?(なし|ない|否定)|閉経|避妊/.test(text)) ctx.pregnancy = 'no'; else if (/妊娠(の)?可能性(あり|ある)/.test(text)) ctx.pregnancy = 'possible';
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
  DDX.Extract = { scrub, local, extract, LLM, validate, catalogText, ageBand };
})(typeof window !== 'undefined' ? window : globalThis);
