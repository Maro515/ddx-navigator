/* ============================================================
 * Medical Knowledge DB  —  腹痛/下痢パック v0.1 (成人・救急/一般外来)
 *  - FeatureDefinition / Disease / DiseaseFeatureRelation
 *  - AcquisitionMetadata / 時間バケット / freshness policy
 *  注意: v0.1 は専門家レビュー前のドラフト。sens/spec は文献値の近似であり
 *        診療推奨値ではない。すべて EvidenceSource で置換・承認する前提。
 * ============================================================ */
(function (g) {
  const KB = {};
  KB.version = 'abd-pack-0.2.0';
  KB.scope = { label: '成人の急性腹痛・急性下痢（外来/救急）', min_age_band: '18-29' };

  /* ---------- 時間バケット ---------- */
  KB.time = {
    tier1: [
      { code: 'minutes', label: '数分' }, { code: 'hours', label: '数時間' }, { code: 'days', label: '数日' },
      { code: 'weeks', label: '数週間' }, { code: 'months', label: '数か月以上' }, { code: 'unknown', label: '不明' }
    ],
    tier2: {
      minutes: [{ code: 'min_lt10', label: '<10分' }, { code: 'min_10_30', label: '10-30分' }, { code: 'min_30_60', label: '30-60分' }],
      hours: [{ code: 'h_1_3', label: '1-3時間' }, { code: 'h_3_6', label: '3-6時間' }, { code: 'h_6_12', label: '6-12時間' }, { code: 'h_12_24', label: '12-24時間' }],
      days: [{ code: 'd_1_2', label: '1-2日' }, { code: 'd_3_7', label: '3-7日' }],
      weeks: [{ code: 'w_1_2', label: '1-2週' }, { code: 'w_3_4', label: '3-4週' }],
      months: [{ code: 'm_1_3', label: '1-3か月' }, { code: 'm_gt3', label: '>3か月' }],
      unknown: [{ code: 'unk_patient', label: '患者不明' }, { code: 'unk_unconfirmed', label: '未確認' }]
    },
    // 代表時間(h)。算術はコード側で行う（Jevに日付差を任せない）
    hours: {
      minutes: 0.5, min_lt10: 0.1, min_10_30: 0.33, min_30_60: 0.75,
      hours: 6, h_1_3: 2, h_3_6: 4.5, h_6_12: 9, h_12_24: 18,
      days: 72, d_1_2: 36, d_3_7: 120,
      weeks: 400, w_1_2: 250, w_3_4: 600,
      months: 3000, m_1_3: 1500, m_gt3: 4000,
      unknown: null, unk_patient: null, unk_unconfirmed: null
    },
    tier1Of(code) {
      if (!code) return 'unknown';
      for (const t of KB.time.tier1) if (t.code === code) return code;
      for (const k in KB.time.tier2) if (KB.time.tier2[k].some(x => x.code === code)) return k;
      return 'unknown';
    },
    label(code) {
      for (const t of KB.time.tier1) if (t.code === code) return t.label;
      for (const k in KB.time.tier2) { const f = KB.time.tier2[k].find(x => x.code === code); if (f) return f.label; }
      return code || '';
    }
  };
  KB.trend = [
    { code: 'worsening', label: '悪化' }, { code: 'stable', label: '持続' }, { code: 'improving', label: '改善' },
    { code: 'fluctuating', label: '変動' }, { code: 'resolved', label: '消失' }, { code: 'unknown', label: '不明' }
  ];
  KB.severity = [{ code: 'mild', label: '軽' }, { code: 'moderate', label: '中' }, { code: 'severe', label: '高' }];
  KB.status = [
    { code: 'present', label: 'あり' }, { code: 'absent', label: 'なし' }, { code: 'unknown', label: '不明' },
    { code: 'not_assessed', label: '未評価/実施不可' }, { code: 'pending', label: '結果待ち' }
  ];
  KB.anchorLabel = { onset: '発症からの経過', observation: '確認してからの経過', collection: '採取からの経過', imaging: '実施からの経過', history: '発生/終了からの経過', none: '' };

  /* ---------- Freshness policy (h) : type 既定、feature で上書き ---------- */
  KB.freshness = { vital: 3, exam: 6, lab: 24, imaging: 72, symptom: null, chief_complaint: null, history: null, context: null };

  /* ---------- 文脈 (Clinical context) ---------- */
  KB.context = {
    age_band: [{ code: 'lt18', label: '<18(対象外)' }, { code: '18-29', label: '18-29' }, { code: '30-39', label: '30-39' }, { code: '40-49', label: '40-49' },
      { code: '50-59', label: '50-59' }, { code: '60-69', label: '60-69' }, { code: '70-79', label: '70-79' }, { code: '80+', label: '80+' }],
    sex: [{ code: 'female', label: '女性' }, { code: 'male', label: '男性' }],
    setting: [{ code: 'emergency', label: '救急外来' }, { code: 'outpatient', label: '一般外来' }, { code: 'night', label: '当直' }],
    pregnancy: [{ code: 'no', label: '妊娠可能性なし' }, { code: 'possible', label: '可能性あり' }, { code: 'confirmed', label: '妊娠中' }, { code: 'unknown', label: '未確認' }],
    trauma: [{ code: 'no', label: '外傷なし' }, { code: 'yes', label: '外傷あり' }]
  };
  KB.ageIndex = { 'lt18': 0, '18-29': 1, '30-39': 2, '40-49': 3, '50-59': 4, '60-69': 5, '70-79': 6, '80+': 7 };

  /* ---------- Feature definitions ---------- */
  // cat: UI カテゴリ, type: feature_type, anchor: 時間の意味, tier2: 二次時間を出す, sev: 程度を聞く
  // acq: {cost, inv, delay, stage}, group: 冗長判定グループ, base: 集団での陽性率(EIG用), mgmt: 管理方針を変える度合(0-3)
  const V = {
    loc: [['rlq', '右下腹部'], ['ruq', '右上腹部'], ['epi', '心窩部'], ['llq', '左下腹部'], ['luq', '左上腹部'], ['umb', '臍周囲'], ['diffuse', 'び漫性'], ['supra', '下腹部正中'], ['flank_r', '右側腹/背部'], ['flank_l', '左側腹/背部']],
    temp: [['lt36', '<36.0(低体温)'], ['lt375', '<37.5'], ['375_38', '37.5-38.0'], ['38_39', '38.0-39.0'], ['ge39', '≥39.0']],
    hr: [['lt60', '<60'], ['60_100', '60-100'], ['100_120', '100-120'], ['gt120', '>120']],
    sbp: [['lt90', '<90'], ['90_100', '90-100'], ['100_140', '100-140'], ['gt140', '>140']],
    rr: [['le20', '≤20'], ['21_24', '21-24'], ['gt24', '>24']],
    spo2: [['ge94', '≥94%'], ['lt94', '<94%']],
    consc: [['alert', '清明'], ['altered', '意識変容']],
    wbc: [['lt4', '<4,000'], ['4_10', '4,000-10,000'], ['10_15', '10,000-15,000'], ['gt15', '>15,000']],
    crp: [['lt1', '<1'], ['1_5', '1-5'], ['5_10', '5-10'], ['gt10', '>10']],
    lact: [['lt2', '<2'], ['2_4', '2-4'], ['gt4', '>4']],
    lip: [['normal', '正常'], ['lt3x', '上昇 <3×ULN'], ['ge3x', '≥3×ULN']],
    ne: [['normal', '正常'], ['elevated', '上昇']],
    np: [['neg', '陰性'], ['pos', '陽性']],
    ua: [['normal', '正常'], ['pyuria', '膿尿'], ['hematuria', '血尿'], ['both', '膿尿+血尿']],
    hb: [['normal', '正常'], ['low', '低下']],
    glu: [['normal', '≤250'], ['gt250', '>250 mg/dL']],
    acid: [['none', 'なし'], ['metabolic', '代謝性アシドーシス']],
    ecg: [['normal', '正常'], ['ischemic', '虚血性変化'], ['af', '心房細動']],
    stool: [['neg', '陰性'], ['cdiff_pos', 'C.difficile陽性'], ['culture_pos', '培養陽性(病原菌)']],
    bs: [['normal', '正常'], ['hyper', '亢進/金属音'], ['hypo', '減弱'], ['absent', '消失']],
    xray: [['normal', '異常なし'], ['free_air', 'free air'], ['air_fluid', '鏡面像'], ['dilated_loops', '腸管拡張']],
    us: [['normal', '異常なし'], ['appendix', '虫垂腫大'], ['gb', '胆嚢腫大/壁肥厚/結石'], ['cbd_dilated', '総胆管拡張'], ['free_fluid', '腹水/骨盤内液体'], ['hydro', '水腎症'], ['aaa', '大動脈瘤'], ['adnexal', '付属器腫瘤']],
    ct: [['normal', '異常なし'], ['appendicitis', '虫垂炎'], ['diverticulitis', '憩室炎'], ['free_air', 'free air'], ['sbo', '腸閉塞'], ['ischemia', '腸管虚血所見'], ['pancreatitis', '膵炎'], ['aortic', 'AAA破裂/解離'], ['stone', '尿管結石'], ['colitis', '大腸炎'], ['cholecystitis', '胆嚢炎/胆管炎'], ['abscess', '膿瘍'], ['hernia', '嵌頓ヘルニア'], ['adnexal', '付属器腫大/捻転'], ['volvulus', '捻転(軸捻)']],
    scrot: [['normal', '正常'], ['tender_swollen', '圧痛/腫脹']],
    vom: [['nonbilious', '非胆汁性'], ['bilious', '胆汁性'], ['hematemesis', '吐血'], ['coffee_ground', 'コーヒー残渣様']],
    dia: [['watery', '水様'], ['bloody', '血性'], ['mucous', '粘液性']],
    onsetc: [['sudden', '突然(秒〜数分で最大)'], ['rapid', '急速(数十分)'], ['gradual', '緩徐(数時間〜)']],
    pchar: [['colicky', '疝痛(波がある)'], ['constant', '持続性'], ['migrating_rlq', '臍周囲→右下腹部へ移動'], ['radiate_back', '背部へ放散'], ['radiate_shoulder', '肩へ放散'], ['radiate_groin', '鼠径部へ放散']],
    gib: [['melena', '黒色便'], ['hematochezia', '血便']]
  };
  const vs = arr => arr.map(([code, label]) => ({ code, label }));
  const F = [];
  function def(id, label, type, cat, o) {
    const d = Object.assign({ id, label, type, cat, anchor: 'observation', tier2: false, sev: false, multi: false,
      acq: { cost: 0, inv: 0, delay: 0, stage: 'bedside' }, group: null, base: 0.2, mgmt: 1, urgent: false, fresh: undefined, values: null }, o || {});
    if (d.values) d.values = vs(d.values);
    F.push(d); return d;
  }
  // 主訴・症状
  def('abd_pain', '腹痛（部位）', 'chief_complaint', 'cc', { anchor: 'onset', tier2: true, sev: true, values: V.loc, base: 0.85, mgmt: 1 });
  def('diarrhea', '下痢', 'chief_complaint', 'cc', { anchor: 'onset', tier2: true, sev: true, values: V.dia, base: 0.35 });
  def('vomiting', '嘔吐', 'chief_complaint', 'cc', { anchor: 'onset', tier2: true, sev: true, values: V.vom, base: 0.4 });
  def('pain_onset_char', '痛みの発症様式', 'symptom', 'cc', { anchor: 'none', values: V.onsetc, base: 0.2, group: 'onset' });
  def('pain_char', '痛みの性状・放散', 'symptom', 'cc', { anchor: 'none', values: V.pchar, base: 0.3, multi: true });
  def('pain_worse_moving', '体動・振動で痛み増悪', 'symptom', 'cc', { anchor: 'none', base: 0.3, group: 'peritoneal' });
  def('nausea', '嘔気', 'symptom', 'cc', { anchor: 'onset', base: 0.5 });
  def('anorexia', '食欲低下', 'symptom', 'cc', { anchor: 'onset', base: 0.45 });
  def('fever_sub', '発熱感・悪寒', 'symptom', 'cc', { anchor: 'onset', tier2: true, base: 0.3, group: 'fever' });
  def('obstipation', '排ガス・排便の停止', 'symptom', 'cc', { anchor: 'onset', tier2: true, base: 0.12 });
  def('gi_bleed', '黒色便・血便', 'symptom', 'cc', { anchor: 'onset', values: V.gib, base: 0.08, mgmt: 2 });
  def('dysuria', '排尿時痛・頻尿', 'symptom', 'cc', { anchor: 'onset', base: 0.12 });
  def('vaginal_bleeding', '不正性器出血', 'symptom', 'cc', { anchor: 'onset', base: 0.05, mgmt: 2 });
  def('jaundice_sub', '黄疸（自覚/他覚）', 'symptom', 'cc', { anchor: 'onset', base: 0.04, mgmt: 2 });
  def('weight_loss', '体重減少（数週以上）', 'symptom', 'cc', { anchor: 'onset', base: 0.06 });
  def('chest_sx', '胸痛・呼吸苦・冷汗', 'symptom', 'cc', { anchor: 'onset', base: 0.06, mgmt: 3, urgent: true });
  def('syncope', '失神・前失神', 'symptom', 'cc', { anchor: 'onset', base: 0.04, mgmt: 3, urgent: true });
  def('sick_contact_food', '周囲の同症状・疑わしい食事', 'symptom', 'cc', { anchor: 'onset', base: 0.15 });
  def('scrotal_pain', '陰嚢・精巣の痛み', 'symptom', 'cc', { anchor: 'onset', base: 0.02, mgmt: 3, urgent: true });
  // 既往・背景
  def('lmp_delayed', '月経の遅れ', 'history', 'hx', { anchor: 'none', base: 0.1, mgmt: 3 });
  def('prior_abd_surgery', '腹部手術歴', 'history', 'hx', { anchor: 'history', base: 0.25 });
  def('alcohol_heavy', '多量飲酒', 'history', 'hx', { anchor: 'none', base: 0.1 });
  def('nsaid_aspirin', 'NSAIDs/アスピリン使用', 'history', 'hx', { anchor: 'history', base: 0.2 });
  def('anticoag', '抗凝固/抗血小板薬', 'history', 'hx', { anchor: 'none', base: 0.1, mgmt: 2 });
  def('recent_abx', '最近の抗菌薬使用', 'history', 'hx', { anchor: 'history', tier2: true, base: 0.1 });
  def('hospitalized_recent', '最近の入院・施設入所', 'history', 'hx', { anchor: 'history', base: 0.1 });
  def('travel', '海外渡航（数週以内）', 'history', 'hx', { anchor: 'history', base: 0.03 });
  def('af_vascular', '心房細動・動脈硬化性疾患', 'history', 'hx', { anchor: 'none', base: 0.1, mgmt: 2 });
  def('cv_risk', '高血圧・糖尿病・脂質異常・喫煙', 'history', 'hx', { anchor: 'none', base: 0.35 });
  def('diabetes', '糖尿病', 'history', 'hx', { anchor: 'none', base: 0.12, mgmt: 2 });
  def('immunosupp', '免疫抑制状態（ステロイド/化学療法等）', 'history', 'hx', { anchor: 'none', base: 0.05, mgmt: 2 });
  def('gallstone_hx', '胆石の既往', 'history', 'hx', { anchor: 'none', base: 0.08 });
  def('ibd_hx', '炎症性腸疾患の既往', 'history', 'hx', { anchor: 'none', base: 0.02 });
  def('divertic_hx', '憩室症/憩室炎の既往', 'history', 'hx', { anchor: 'none', base: 0.06 });
  def('pud_hx', '消化性潰瘍の既往', 'history', 'hx', { anchor: 'none', base: 0.06 });
  def('hernia_hx', 'ヘルニアの既往', 'history', 'hx', { anchor: 'none', base: 0.04 });
  def('similar_episodes', '同様の発作の既往', 'history', 'hx', { anchor: 'none', base: 0.15 });
  // 身体診察
  def('rebound_guarding', '腹膜刺激徴候（反跳痛/筋性防御）', 'exam', 'exam', { base: 0.2, mgmt: 3, group: 'peritoneal', urgent: true });
  def('rigidity', '板状硬', 'exam', 'exam', { base: 0.03, mgmt: 3, group: 'peritoneal', urgent: true });
  def('tender_rlq', '右下腹部圧痛（McBurney）', 'exam', 'exam', { base: 0.25, group: 'tender_r' });
  def('tender_ruq', '右上腹部圧痛', 'exam', 'exam', { base: 0.15, group: 'tender_ruq' });
  def('murphy', 'Murphy徴候', 'exam', 'exam', { base: 0.08, group: 'tender_ruq' });
  def('tender_llq', '左下腹部圧痛', 'exam', 'exam', { base: 0.12 });
  def('tender_epi', '心窩部圧痛', 'exam', 'exam', { base: 0.3 });
  def('distension', '腹部膨満', 'exam', 'exam', { base: 0.15 });
  def('bowel_sounds', '腸蠕動音', 'exam', 'exam', { values: V.bs, base: 0.2 });
  def('cva_tender', 'CVA叩打痛', 'exam', 'exam', { base: 0.12 });
  def('pulsatile_mass', '拍動性腹部腫瘤', 'exam', 'exam', { base: 0.01, mgmt: 3, urgent: true });
  def('hernia_irreducible', '還納不能ヘルニア（鼠径/腹壁）', 'exam', 'exam', { base: 0.01, mgmt: 3, urgent: true });
  def('pain_disproportion', '所見に比して強い痛み', 'exam', 'exam', { base: 0.04, mgmt: 3, urgent: true });
  def('psoas_obturator', 'Psoas/閉鎖筋徴候', 'exam', 'exam', { base: 0.05, group: 'tender_r' });
  def('dehydration_signs', '脱水所見（口腔乾燥/ツルゴール低下）', 'exam', 'exam', { base: 0.2 });
  def('rectal_blood', '直腸診で血液', 'exam', 'exam', { base: 0.05, acq: { cost: 0, inv: 1, delay: 0, stage: 'bedside' } });
  def('adnexal_tender', '付属器圧痛/子宮頸部移動痛', 'exam', 'exam', { base: 0.08, acq: { cost: 0, inv: 1, delay: 0, stage: 'bedside' }, mgmt: 2 });
  def('scrotal_exam', '陰嚢診察', 'exam', 'exam', { values: V.scrot, base: 0.02, mgmt: 3 });
  def('skin_pallor_cold', '末梢冷感・蒼白', 'exam', 'exam', { base: 0.05, urgent: true, mgmt: 2 });
  // バイタル
  def('temp', '体温', 'vital', 'vital', { values: V.temp, base: 0.3, group: 'fever', urgent: true });
  def('hr', '心拍数', 'vital', 'vital', { values: V.hr, base: 0.3, urgent: true });
  def('sbp', '収縮期血圧', 'vital', 'vital', { values: V.sbp, base: 0.08, urgent: true, mgmt: 3 });
  def('rr', '呼吸数', 'vital', 'vital', { values: V.rr, base: 0.15, urgent: true });
  def('spo2', 'SpO2', 'vital', 'vital', { values: V.spo2, base: 0.05, urgent: true });
  def('consciousness', '意識状態', 'vital', 'vital', { values: V.consc, base: 0.03, urgent: true, mgmt: 3 });
  // 検査
  const LAB = { cost: 1, inv: 1, delay: 2, stage: 'lab' };
  const POC = { cost: 1, inv: 1, delay: 1, stage: 'lab' };
  def('wbc', '白血球数', 'lab', 'lab', { anchor: 'collection', tier2: true, values: V.wbc, acq: LAB, base: 0.4 });
  def('crp', 'CRP (mg/dL)', 'lab', 'lab', { anchor: 'collection', tier2: true, values: V.crp, acq: LAB, base: 0.4 });
  def('lactate', '乳酸 (mmol/L)', 'lab', 'lab', { anchor: 'collection', tier2: true, values: V.lact, acq: POC, base: 0.1, mgmt: 3, fresh: 6 });
  def('lipase', 'リパーゼ/アミラーゼ', 'lab', 'lab', { anchor: 'collection', values: V.lip, acq: LAB, base: 0.08, mgmt: 3 });
  def('liver_enz', 'AST/ALT', 'lab', 'lab', { anchor: 'collection', values: V.ne, acq: LAB, base: 0.12 });
  def('bili', 'ビリルビン', 'lab', 'lab', { anchor: 'collection', values: V.ne, acq: LAB, base: 0.08, mgmt: 2 });
  def('alp_ggt', 'ALP/γ-GTP', 'lab', 'lab', { anchor: 'collection', values: V.ne, acq: LAB, base: 0.1 });
  def('renal', 'Cre/BUN', 'lab', 'lab', { anchor: 'collection', values: V.ne, acq: LAB, base: 0.12, mgmt: 2 });
  def('hcg', '妊娠反応（尿/血中hCG）', 'lab', 'lab', { anchor: 'collection', values: V.np, acq: POC, base: 0.03, mgmt: 3 });
  def('urinalysis', '尿検査', 'lab', 'lab', { anchor: 'collection', values: V.ua, acq: POC, base: 0.2 });
  def('hb', 'ヘモグロビン', 'lab', 'lab', { anchor: 'collection', values: V.hb, acq: LAB, base: 0.12, mgmt: 2 });
  def('glucose', '血糖', 'lab', 'lab', { anchor: 'collection', values: V.glu, acq: POC, base: 0.04, mgmt: 3 });
  def('acidosis', '血液ガス（アシドーシス）', 'lab', 'lab', { anchor: 'collection', values: V.acid, acq: POC, base: 0.06, mgmt: 3, fresh: 6 });
  def('troponin', 'トロポニン', 'lab', 'lab', { anchor: 'collection', values: V.np, acq: LAB, base: 0.02, mgmt: 3 });
  def('ddimer', 'D-dimer', 'lab', 'lab', { anchor: 'collection', values: V.ne, acq: LAB, base: 0.2 });
  def('ecg', '心電図', 'lab', 'lab', { anchor: 'collection', values: V.ecg, acq: { cost: 0, inv: 0, delay: 1, stage: 'lab' }, base: 0.06, mgmt: 3 });
  def('stool_test', '便検査（培養/CDトキシン）', 'lab', 'lab', { anchor: 'collection', values: V.stool, acq: { cost: 1, inv: 0, delay: 3, stage: 'lab' }, base: 0.05, mgmt: 2 });
  // 画像
  def('xray', '腹部単純X線', 'imaging', 'img', { anchor: 'imaging', values: V.xray, multi: true, acq: { cost: 1, inv: 1, delay: 1, stage: 'imaging' }, base: 0.1, mgmt: 2 });
  def('us', '腹部超音波', 'imaging', 'img', { anchor: 'imaging', values: V.us, multi: true, acq: { cost: 1, inv: 0, delay: 1, stage: 'imaging' }, base: 0.15, mgmt: 3 });
  def('ct', '腹部CT', 'imaging', 'img', { anchor: 'imaging', values: V.ct, multi: true, acq: { cost: 3, inv: 2, delay: 2, stage: 'imaging' }, base: 0.3, mgmt: 3 });

  KB.features = F;
  KB.feature = Object.fromEntries(F.map(f => [f.id, f]));
  KB.categories = [
    { code: 'cc', label: '主訴・症状' }, { code: 'hx', label: '既往・背景' }, { code: 'exam', label: '身体診察' },
    { code: 'vital', label: 'バイタル' }, { code: 'lab', label: '検査' }, { code: 'img', label: '画像' }
  ];
  KB.typeLabel = { chief_complaint: '主訴', symptom: '問診', history: '背景', exam: '診察', vital: 'バイタル', lab: '検査', imaging: '画像', context: '文脈' };

  /* ---------- Diseases ---------- */
  // urgency: emergent(直ちに) / urgent(数時間以内) / routine
  // onset: 主訴発症からの経過(tier1)との適合倍率。trend: 経過との適合倍率
  // requires: 適用条件(満たさなければ候補から除外)。mult: 文脈による事前確率倍率
  // clear: MNM を「概ね除外」するのに使う feature 群
  const D = [];
  function dis(id, label, o) { D.push(Object.assign({ id, label, urgency: 'routine', mnm: false, prior: 0.05, comorbid: false,
      onset: { minutes: 1, hours: 1, days: 1, weeks: 1, months: 1, unknown: 1 }, trend: {}, requires: {}, mult: [], clear: [], note: '' }, o)); }
  const SURG_TREND = { worsening: 1.2, improving: 0.6, resolved: 0.3 };
  const BENIGN_TREND = { improving: 1.3, resolved: 1.3, worsening: 0.8 };
  dis('appendicitis', '急性虫垂炎', { urgency: 'urgent', prior: 0.10, onset: { minutes: 0.3, hours: 1, days: 0.9, weeks: 0.1, months: 0.02, unknown: 0.7 }, trend: SURG_TREND,
    mult: [{ when: { age_max: '30-39' }, x: 1.5 }, { when: { age_min: '60-69' }, x: 0.6 }] });
  dis('cholecystitis', '急性胆嚢炎', { urgency: 'urgent', prior: 0.07, onset: { minutes: 0.3, hours: 1, days: 1, weeks: 0.2, months: 0.05, unknown: 0.7 }, trend: SURG_TREND,
    mult: [{ when: { age_min: '40-49' }, x: 1.5 }] });
  dis('biliary_colic', '胆石発作/総胆管結石', { prior: 0.05, onset: { minutes: 0.8, hours: 1, days: 0.5, weeks: 0.2, months: 0.1, unknown: 0.7 }, trend: BENIGN_TREND });
  dis('cholangitis', '急性胆管炎', { urgency: 'emergent', mnm: true, prior: 0.02, onset: { minutes: 0.3, hours: 1, days: 1, weeks: 0.3, months: 0.05, unknown: 0.7 }, trend: SURG_TREND,
    clear: ['temp', 'bili', 'alp_ggt', 'us'], note: '敗血症化しやすく、早期の胆道ドレナージ判断が必要' });
  dis('pancreatitis', '急性膵炎', { urgency: 'urgent', prior: 0.05, onset: { minutes: 0.5, hours: 1, days: 0.8, weeks: 0.1, months: 0.02, unknown: 0.7 }, trend: SURG_TREND });
  dis('pud_gastritis', '消化性潰瘍/急性胃炎', { prior: 0.08, onset: { minutes: 0.3, hours: 0.8, days: 1, weeks: 1, months: 0.5, unknown: 0.8 }, trend: BENIGN_TREND });
  dis('perforation', '消化管穿孔', { urgency: 'emergent', mnm: true, prior: 0.015, onset: { minutes: 1, hours: 1, days: 0.5, weeks: 0.05, months: 0.01, unknown: 0.6 }, trend: SURG_TREND,
    clear: ['rebound_guarding', 'rigidity', 'xray', 'ct'], note: '腹膜炎・敗血症へ進行。緊急外科' });
  dis('sbo', '腸閉塞（癒着/軸捻含む）', { urgency: 'urgent', prior: 0.05, onset: { minutes: 0.4, hours: 1, days: 1, weeks: 0.2, months: 0.05, unknown: 0.7 }, trend: SURG_TREND,
    mult: [{ when: { age_min: '60-69' }, x: 1.5 }] });
  dis('mesenteric_ischemia', '急性腸間膜虚血', { urgency: 'emergent', mnm: true, prior: 0.01, onset: { minutes: 1, hours: 1, days: 0.4, weeks: 0.05, months: 0.01, unknown: 0.6 }, trend: SURG_TREND,
    mult: [{ when: { age_min: '60-69' }, x: 3 }], clear: ['lactate', 'ct', 'af_vascular', 'pain_disproportion'], note: '時間依存性に致死率上昇。造影CT・血管外科' });
  dis('ruptured_aaa', '腹部大動脈瘤破裂', { urgency: 'emergent', mnm: true, prior: 0.005, onset: { minutes: 1, hours: 0.8, days: 0.2, weeks: 0.02, months: 0.01, unknown: 0.5 }, trend: SURG_TREND,
    mult: [{ when: { age_min: '60-69' }, x: 4 }, { when: { sex: 'male' }, x: 2 }], clear: ['us', 'ct', 'pulsatile_mass'], note: '不安定なら画像を待たず血管外科' });
  dis('aortic_dissection', '大動脈解離', { urgency: 'emergent', mnm: true, prior: 0.004, onset: { minutes: 1, hours: 0.8, days: 0.2, weeks: 0.02, months: 0.01, unknown: 0.5 }, trend: {},
    mult: [{ when: { age_min: '50-59' }, x: 2 }], clear: ['ct', 'ddimer', 'chest_sx'], note: '造影CT。血圧左右差・縦隔拡大も参考' });
  dis('acs', '急性冠症候群（下壁）', { urgency: 'emergent', mnm: true, prior: 0.01, onset: { minutes: 1, hours: 1, days: 0.3, weeks: 0.05, months: 0.01, unknown: 0.6 }, trend: {},
    mult: [{ when: { age_min: '50-59' }, x: 2 }], clear: ['ecg', 'troponin'], note: '心窩部痛で来院する。12誘導心電図を早期に' });
  dis('ectopic_pregnancy', '異所性妊娠', { urgency: 'emergent', mnm: true, prior: 0.02, onset: { minutes: 0.8, hours: 1, days: 1, weeks: 0.3, months: 0.02, unknown: 0.7 }, trend: {},
    requires: { sex: 'female', pregnancy_not: ['no'], age_max: '40-49' }, clear: ['hcg', 'us'], note: 'hCG陰性で概ね除外。陽性なら経腟超音波・産婦人科' });
  dis('ovarian_torsion', '卵巣捻転', { urgency: 'emergent', mnm: true, prior: 0.01, onset: { minutes: 1, hours: 1, days: 0.5, weeks: 0.05, months: 0.01, unknown: 0.6 }, trend: SURG_TREND,
    requires: { sex: 'female' }, clear: ['us', 'ct'], note: '突然発症の片側下腹部痛+嘔吐。超音波ドプラ' });
  dis('pid', '骨盤内炎症性疾患', { prior: 0.03, onset: { minutes: 0.2, hours: 0.6, days: 1, weeks: 0.6, months: 0.1, unknown: 0.7 }, trend: {},
    requires: { sex: 'female', age_max: '40-49' } });
  dis('ureteral_stone', '尿管結石', { prior: 0.07, onset: { minutes: 1, hours: 1, days: 0.5, weeks: 0.1, months: 0.02, unknown: 0.7 }, trend: { fluctuating: 1.3 } });
  dis('pyelonephritis', '腎盂腎炎/尿路感染', { urgency: 'urgent', prior: 0.05, onset: { minutes: 0.2, hours: 0.7, days: 1, weeks: 0.3, months: 0.05, unknown: 0.7 }, trend: {},
    mult: [{ when: { sex: 'female' }, x: 2 }] });
  dis('diverticulitis', '急性憩室炎', { urgency: 'urgent', prior: 0.05, onset: { minutes: 0.2, hours: 0.7, days: 1, weeks: 0.3, months: 0.05, unknown: 0.7 }, trend: SURG_TREND,
    mult: [{ when: { age_min: '40-49' }, x: 2 }] });
  dis('gastroenteritis', '感染性腸炎（ウイルス性/軽症細菌性）', { prior: 0.20, onset: { minutes: 0.3, hours: 0.8, days: 1, weeks: 0.3, months: 0.05, unknown: 0.7 }, trend: BENIGN_TREND });
  dis('bacterial_colitis', '細菌性腸炎（血性下痢/出血性大腸炎）', { urgency: 'urgent', prior: 0.05, onset: { minutes: 0.2, hours: 0.6, days: 1, weeks: 0.3, months: 0.05, unknown: 0.7 }, trend: {} });
  dis('cdiff', 'C. difficile感染症', { urgency: 'urgent', prior: 0.02, onset: { minutes: 0.1, hours: 0.4, days: 1, weeks: 0.8, months: 0.1, unknown: 0.7 }, trend: {},
    mult: [{ when: { age_min: '60-69' }, x: 2 }] });
  dis('ibd_flare', '炎症性腸疾患（増悪/初発）', { prior: 0.02, onset: { minutes: 0.05, hours: 0.2, days: 0.8, weeks: 1, months: 0.8, unknown: 0.7 }, trend: {} });
  dis('ischemic_colitis', '虚血性大腸炎', { urgency: 'urgent', prior: 0.02, onset: { minutes: 0.8, hours: 1, days: 0.8, weeks: 0.1, months: 0.02, unknown: 0.7 }, trend: BENIGN_TREND,
    mult: [{ when: { age_min: '60-69' }, x: 3 }] });
  dis('incarcerated_hernia', '嵌頓ヘルニア', { urgency: 'emergent', mnm: true, prior: 0.01, onset: { minutes: 0.8, hours: 1, days: 0.6, weeks: 0.05, months: 0.01, unknown: 0.6 }, trend: SURG_TREND,
    clear: ['hernia_irreducible', 'ct'], note: 'ヘルニア門の診察を省略しない' });
  dis('dka', '糖尿病性ケトアシドーシス', { urgency: 'emergent', mnm: true, prior: 0.005, onset: { minutes: 0.3, hours: 1, days: 1, weeks: 0.1, months: 0.02, unknown: 0.7 }, trend: {},
    mult: [{ when: { feature: 'diabetes' }, x: 10 }], clear: ['glucose', 'acidosis'], note: '腹痛・嘔吐で来院。血糖とガスで確認' });
  dis('toxic_megacolon', '中毒性巨大結腸症', { urgency: 'emergent', mnm: true, prior: 0.003, onset: { minutes: 0.1, hours: 0.6, days: 1, weeks: 0.5, months: 0.05, unknown: 0.6 }, trend: SURG_TREND,
    clear: ['xray', 'distension', 'ct'], note: '重症大腸炎+全身毒性。腹部X線で結腸径' });
  dis('testicular_torsion', '精巣捻転', { urgency: 'emergent', mnm: true, prior: 0.003, onset: { minutes: 1, hours: 1, days: 0.3, weeks: 0.02, months: 0.01, unknown: 0.5 }, trend: {},
    requires: { sex: 'male', age_max: '30-39' }, clear: ['scrotal_exam', 'scrotal_pain'], note: '若年男性の下腹部痛では陰嚢診察を省略しない' });
  dis('nonspecific_ap', '非特異的腹痛/便秘', { prior: 0.15, onset: { minutes: 0.5, hours: 0.8, days: 1, weeks: 1, months: 0.8, unknown: 0.8 }, trend: BENIGN_TREND });
  dis('dehydration', '脱水/電解質異常（併存病態）', { prior: 0.10, comorbid: true, onset: { minutes: 0.3, hours: 0.8, days: 1, weeks: 0.5, months: 0.2, unknown: 0.7 } });

  KB.diseases = D;
  KB.disease = Object.fromEntries(D.map(d => [d.id, d]));

  /* ---------- Disease–Feature relations ----------
   * R(disease, feature, values|null, sens, spec, opts)
   *  values: この値集合を「陽性」とみなす(null=あり/なし二値)
   *  sens: P(陽性|疾患), spec: P(陰性|非疾患)  → LR+ = sens/(1-spec), LR- = (1-sens)/spec
   *  opts.key: 決定的(陰性なら MNM 解除の根拠、陽性なら強い支持)
   */
  const REL = [];
  function R(d, f, values, sens, spec, opts) {
    if (!KB.disease[d]) throw new Error('unknown disease ' + d);
    if (!KB.feature[f]) throw new Error('unknown feature ' + f);
    REL.push(Object.assign({ d, f, values: values || null, sens, spec }, opts || {}));
  }
  const FEV = ['375_38', '38_39', 'ge39'], HIFEV = ['38_39', 'ge39'], WBC_HI = ['10_15', 'gt15'], CRP_HI = ['1_5', '5_10', 'gt10'], CRP_VHI = ['5_10', 'gt10'];
  const TACHY = ['100_120', 'gt120'], HYPO = ['lt90', '90_100'];
  // 急性虫垂炎
  R('appendicitis', 'abd_pain', ['rlq'], 0.80, 0.85); R('appendicitis', 'pain_char', ['migrating_rlq'], 0.55, 0.85);
  R('appendicitis', 'anorexia', null, 0.70, 0.50); R('appendicitis', 'nausea', null, 0.65, 0.45); R('appendicitis', 'vomiting', null, 0.55, 0.55);
  R('appendicitis', 'tender_rlq', null, 0.90, 0.60); R('appendicitis', 'rebound_guarding', null, 0.55, 0.75); R('appendicitis', 'psoas_obturator', null, 0.20, 0.92);
  R('appendicitis', 'pain_worse_moving', null, 0.60, 0.70); R('appendicitis', 'temp', FEV, 0.50, 0.65); R('appendicitis', 'wbc', WBC_HI, 0.80, 0.55);
  R('appendicitis', 'crp', CRP_HI, 0.70, 0.60); R('appendicitis', 'diarrhea', null, 0.15, 0.65);
  R('appendicitis', 'us', ['appendix'], 0.80, 0.95, { key: true }); R('appendicitis', 'ct', ['appendicitis'], 0.95, 0.96, { key: true });
  // 急性胆嚢炎
  R('cholecystitis', 'abd_pain', ['ruq', 'epi'], 0.85, 0.70); R('cholecystitis', 'murphy', null, 0.65, 0.85); R('cholecystitis', 'tender_ruq', null, 0.80, 0.70);
  R('cholecystitis', 'temp', FEV, 0.50, 0.65); R('cholecystitis', 'wbc', WBC_HI, 0.65, 0.55); R('cholecystitis', 'crp', CRP_HI, 0.75, 0.60);
  R('cholecystitis', 'gallstone_hx', null, 0.50, 0.90); R('cholecystitis', 'vomiting', null, 0.60, 0.55); R('cholecystitis', 'liver_enz', ['elevated'], 0.30, 0.85);
  R('cholecystitis', 'us', ['gb'], 0.85, 0.90, { key: true }); R('cholecystitis', 'ct', ['cholecystitis'], 0.80, 0.95, { key: true });
  // 胆石発作/総胆管結石
  R('biliary_colic', 'abd_pain', ['ruq', 'epi'], 0.85, 0.70); R('biliary_colic', 'pain_char', ['colicky', 'radiate_back', 'radiate_shoulder'], 0.55, 0.75);
  R('biliary_colic', 'gallstone_hx', null, 0.60, 0.90); R('biliary_colic', 'similar_episodes', null, 0.50, 0.75); R('biliary_colic', 'bili', ['elevated'], 0.50, 0.88);
  R('biliary_colic', 'alp_ggt', ['elevated'], 0.60, 0.82); R('biliary_colic', 'liver_enz', ['elevated'], 0.50, 0.85); R('biliary_colic', 'murphy', null, 0.20, 0.85);
  R('biliary_colic', 'temp', FEV, 0.10, 0.65); R('biliary_colic', 'us', ['gb'], 0.65, 0.90, { key: true }); R('biliary_colic', 'us', ['cbd_dilated'], 0.50, 0.95, { key: true }); R('biliary_colic', 'vomiting', null, 0.50, 0.55);
  // 急性胆管炎
  R('cholangitis', 'abd_pain', ['ruq', 'epi'], 0.70, 0.70); R('cholangitis', 'temp', HIFEV, 0.80, 0.70); R('cholangitis', 'fever_sub', null, 0.80, 0.70);
  R('cholangitis', 'jaundice_sub', null, 0.50, 0.95); R('cholangitis', 'bili', ['elevated'], 0.80, 0.88, { key: true }); R('cholangitis', 'alp_ggt', ['elevated'], 0.85, 0.80, { key: true });
  R('cholangitis', 'us', ['cbd_dilated'], 0.70, 0.92, { key: true }); R('cholangitis', 'ct', ['cholecystitis'], 0.60, 0.95); R('cholangitis', 'consciousness', ['altered'], 0.15, 0.97);
  R('cholangitis', 'sbp', ['lt90'], 0.15, 0.95); R('cholangitis', 'wbc', WBC_HI, 0.80, 0.55); R('cholangitis', 'crp', CRP_VHI, 0.70, 0.75); R('cholangitis', 'gallstone_hx', null, 0.50, 0.90);
  R('cholangitis', 'hr', TACHY, 0.60, 0.65);
  // 急性膵炎
  R('pancreatitis', 'abd_pain', ['epi', 'diffuse'], 0.90, 0.60); R('pancreatitis', 'pain_char', ['radiate_back'], 0.50, 0.88); R('pancreatitis', 'alcohol_heavy', null, 0.40, 0.88);
  R('pancreatitis', 'gallstone_hx', null, 0.35, 0.90); R('pancreatitis', 'vomiting', null, 0.75, 0.55); R('pancreatitis', 'tender_epi', null, 0.85, 0.65);
  R('pancreatitis', 'lipase', ['ge3x'], 0.90, 0.95, { key: true }); R('pancreatitis', 'lipase', ['lt3x'], 0.08, 0.90); R('pancreatitis', 'ct', ['pancreatitis'], 0.80, 0.96, { key: true });
  R('pancreatitis', 'crp', CRP_HI, 0.70, 0.60); R('pancreatitis', 'hr', TACHY, 0.55, 0.65);
  // 消化性潰瘍/胃炎
  R('pud_gastritis', 'abd_pain', ['epi'], 0.85, 0.60); R('pud_gastritis', 'nsaid_aspirin', null, 0.40, 0.82); R('pud_gastritis', 'pud_hx', null, 0.40, 0.92);
  R('pud_gastritis', 'gi_bleed', ['melena'], 0.15, 0.96); R('pud_gastritis', 'vomiting', ['hematemesis', 'coffee_ground'], 0.12, 0.98); R('pud_gastritis', 'tender_epi', null, 0.70, 0.65);
  R('pud_gastritis', 'rebound_guarding', null, 0.05, 0.75); R('pud_gastritis', 'temp', FEV, 0.05, 0.65); R('pud_gastritis', 'nausea', null, 0.60, 0.45);
  // 消化管穿孔
  R('perforation', 'pain_onset_char', ['sudden'], 0.70, 0.82); R('perforation', 'rigidity', null, 0.60, 0.97, { key: true }); R('perforation', 'rebound_guarding', null, 0.85, 0.75, { key: true });
  R('perforation', 'abd_pain', ['diffuse', 'epi'], 0.80, 0.55); R('perforation', 'xray', ['free_air'], 0.60, 0.99, { key: true }); R('perforation', 'ct', ['free_air'], 0.95, 0.99, { key: true });
  R('perforation', 'pud_hx', null, 0.30, 0.92); R('perforation', 'nsaid_aspirin', null, 0.35, 0.82); R('perforation', 'bowel_sounds', ['absent', 'hypo'], 0.60, 0.80);
  R('perforation', 'hr', TACHY, 0.65, 0.65); R('perforation', 'temp', FEV, 0.45, 0.65); R('perforation', 'wbc', WBC_HI, 0.75, 0.55); R('perforation', 'lactate', ['2_4', 'gt4'], 0.40, 0.88);
  R('perforation', 'pain_worse_moving', null, 0.80, 0.70);
  // 腸閉塞
  R('sbo', 'prior_abd_surgery', null, 0.70, 0.72); R('sbo', 'vomiting', ['bilious'], 0.60, 0.88); R('sbo', 'vomiting', null, 0.85, 0.55); R('sbo', 'obstipation', null, 0.70, 0.85);
  R('sbo', 'distension', null, 0.70, 0.75); R('sbo', 'pain_char', ['colicky'], 0.70, 0.70); R('sbo', 'bowel_sounds', ['hyper'], 0.50, 0.85);
  R('sbo', 'xray', ['air_fluid', 'dilated_loops'], 0.75, 0.88, { key: true }); R('sbo', 'ct', ['sbo', 'volvulus'], 0.95, 0.96, { key: true }); R('sbo', 'hernia_irreducible', null, 0.12, 0.98);
  R('sbo', 'diarrhea', null, 0.10, 0.65); R('sbo', 'abd_pain', ['diffuse', 'umb'], 0.75, 0.55);
  // 急性腸間膜虚血
  R('mesenteric_ischemia', 'af_vascular', null, 0.60, 0.88, { key: true }); R('mesenteric_ischemia', 'pain_disproportion', null, 0.70, 0.92, { key: true });
  R('mesenteric_ischemia', 'abd_pain', ['diffuse', 'umb'], 0.80, 0.55); R('mesenteric_ischemia', 'pain_onset_char', ['sudden', 'rapid'], 0.60, 0.75);
  R('mesenteric_ischemia', 'lactate', ['gt4'], 0.55, 0.92, { key: true }); R('mesenteric_ischemia', 'lactate', ['2_4', 'gt4'], 0.80, 0.80);
  R('mesenteric_ischemia', 'acidosis', ['metabolic'], 0.50, 0.90); R('mesenteric_ischemia', 'ecg', ['af'], 0.40, 0.93); R('mesenteric_ischemia', 'ct', ['ischemia'], 0.90, 0.96, { key: true });
  R('mesenteric_ischemia', 'gi_bleed', null, 0.25, 0.92); R('mesenteric_ischemia', 'wbc', ['gt15'], 0.60, 0.80); R('mesenteric_ischemia', 'vomiting', null, 0.50, 0.55); R('mesenteric_ischemia', 'diarrhea', null, 0.35, 0.65);
  R('mesenteric_ischemia', 'rebound_guarding', null, 0.30, 0.75);
  // 腹部大動脈瘤破裂
  R('ruptured_aaa', 'pulsatile_mass', null, 0.50, 0.97, { key: true }); R('ruptured_aaa', 'pain_onset_char', ['sudden'], 0.75, 0.82); R('ruptured_aaa', 'abd_pain', ['flank_l', 'flank_r', 'diffuse', 'umb'], 0.80, 0.50);
  R('ruptured_aaa', 'syncope', null, 0.30, 0.96); R('ruptured_aaa', 'sbp', ['lt90'], 0.45, 0.93); R('ruptured_aaa', 'hr', TACHY, 0.60, 0.65); R('ruptured_aaa', 'cv_risk', null, 0.80, 0.45);
  R('ruptured_aaa', 'us', ['aaa'], 0.90, 0.98, { key: true }); R('ruptured_aaa', 'ct', ['aortic'], 0.98, 0.99, { key: true }); R('ruptured_aaa', 'skin_pallor_cold', null, 0.40, 0.93);
  R('ruptured_aaa', 'hb', ['low'], 0.45, 0.85); R('ruptured_aaa', 'pain_char', ['radiate_back', 'radiate_groin'], 0.50, 0.80);
  // 大動脈解離
  R('aortic_dissection', 'chest_sx', null, 0.70, 0.92, { key: true }); R('aortic_dissection', 'pain_onset_char', ['sudden'], 0.85, 0.82); R('aortic_dissection', 'pain_char', ['radiate_back'], 0.55, 0.85);
  R('aortic_dissection', 'cv_risk', null, 0.75, 0.45); R('aortic_dissection', 'sbp', ['gt140'], 0.50, 0.70); R('aortic_dissection', 'ddimer', ['elevated'], 0.95, 0.55, { key: true });
  R('aortic_dissection', 'ct', ['aortic'], 0.98, 0.99, { key: true }); R('aortic_dissection', 'syncope', null, 0.15, 0.96); R('aortic_dissection', 'abd_pain', ['epi', 'flank_l', 'flank_r', 'diffuse'], 0.80, 0.50);
  // 急性冠症候群
  R('acs', 'abd_pain', ['epi'], 0.70, 0.60); R('acs', 'chest_sx', null, 0.65, 0.92, { key: true }); R('acs', 'nausea', null, 0.50, 0.45); R('acs', 'vomiting', null, 0.40, 0.55);
  R('acs', 'diabetes', null, 0.30, 0.88); R('acs', 'cv_risk', null, 0.85, 0.45); R('acs', 'troponin', ['pos'], 0.92, 0.95, { key: true }); R('acs', 'ecg', ['ischemic'], 0.60, 0.96, { key: true });
  R('acs', 'skin_pallor_cold', null, 0.40, 0.93); R('acs', 'tender_epi', null, 0.15, 0.65); R('acs', 'rebound_guarding', null, 0.02, 0.75);
  // 異所性妊娠
  R('ectopic_pregnancy', 'lmp_delayed', null, 0.70, 0.88); R('ectopic_pregnancy', 'vaginal_bleeding', null, 0.60, 0.92); R('ectopic_pregnancy', 'abd_pain', ['rlq', 'llq', 'supra'], 0.85, 0.55);
  R('ectopic_pregnancy', 'hcg', ['pos'], 0.99, 0.92, { key: true }); R('ectopic_pregnancy', 'us', ['adnexal', 'free_fluid'], 0.75, 0.92, { key: true }); R('ectopic_pregnancy', 'adnexal_tender', null, 0.60, 0.85);
  R('ectopic_pregnancy', 'syncope', null, 0.15, 0.96); R('ectopic_pregnancy', 'sbp', ['lt90'], 0.10, 0.93); R('ectopic_pregnancy', 'hb', ['low'], 0.30, 0.85); R('ectopic_pregnancy', 'temp', FEV, 0.05, 0.65);
  // 卵巣捻転
  R('ovarian_torsion', 'pain_onset_char', ['sudden'], 0.70, 0.82); R('ovarian_torsion', 'abd_pain', ['rlq', 'llq', 'supra'], 0.90, 0.55); R('ovarian_torsion', 'vomiting', null, 0.70, 0.55);
  R('ovarian_torsion', 'adnexal_tender', null, 0.65, 0.85); R('ovarian_torsion', 'us', ['adnexal'], 0.85, 0.92, { key: true }); R('ovarian_torsion', 'ct', ['adnexal'], 0.70, 0.95, { key: true });
  R('ovarian_torsion', 'temp', FEV, 0.10, 0.65); R('ovarian_torsion', 'diarrhea', null, 0.05, 0.65);
  // PID
  R('pid', 'abd_pain', ['supra', 'rlq', 'llq'], 0.85, 0.55); R('pid', 'adnexal_tender', null, 0.90, 0.75, { key: true }); R('pid', 'temp', FEV, 0.40, 0.65); R('pid', 'dysuria', null, 0.20, 0.88);
  R('pid', 'crp', CRP_HI, 0.55, 0.60); R('pid', 'hcg', ['pos'], 0.02, 0.92); R('pid', 'urinalysis', ['pyuria'], 0.30, 0.75); R('pid', 'vaginal_bleeding', null, 0.25, 0.92);
  // 尿管結石
  R('ureteral_stone', 'abd_pain', ['flank_r', 'flank_l'], 0.85, 0.80); R('ureteral_stone', 'pain_char', ['colicky', 'radiate_groin'], 0.70, 0.75); R('ureteral_stone', 'cva_tender', null, 0.50, 0.85);
  R('ureteral_stone', 'urinalysis', ['hematuria', 'both'], 0.85, 0.75, { key: true }); R('ureteral_stone', 'us', ['hydro'], 0.70, 0.92, { key: true }); R('ureteral_stone', 'ct', ['stone'], 0.97, 0.97, { key: true });
  R('ureteral_stone', 'similar_episodes', null, 0.40, 0.85); R('ureteral_stone', 'vomiting', null, 0.50, 0.55); R('ureteral_stone', 'temp', HIFEV, 0.05, 0.75); R('ureteral_stone', 'rebound_guarding', null, 0.03, 0.75);
  R('ureteral_stone', 'pain_onset_char', ['sudden', 'rapid'], 0.70, 0.75);
  // 腎盂腎炎/UTI
  R('pyelonephritis', 'dysuria', null, 0.60, 0.85); R('pyelonephritis', 'cva_tender', null, 0.70, 0.85); R('pyelonephritis', 'temp', HIFEV, 0.80, 0.70); R('pyelonephritis', 'fever_sub', null, 0.80, 0.70);
  R('pyelonephritis', 'urinalysis', ['pyuria', 'both'], 0.92, 0.78, { key: true }); R('pyelonephritis', 'abd_pain', ['flank_r', 'flank_l', 'supra'], 0.70, 0.65); R('pyelonephritis', 'wbc', WBC_HI, 0.65, 0.55);
  R('pyelonephritis', 'crp', CRP_HI, 0.80, 0.60); R('pyelonephritis', 'nausea', null, 0.45, 0.45); R('pyelonephritis', 'rebound_guarding', null, 0.03, 0.75);
  // 憩室炎
  R('diverticulitis', 'abd_pain', ['llq'], 0.70, 0.88); R('diverticulitis', 'tender_llq', null, 0.80, 0.78); R('diverticulitis', 'divertic_hx', null, 0.40, 0.92); R('diverticulitis', 'temp', FEV, 0.50, 0.65);
  R('diverticulitis', 'wbc', WBC_HI, 0.60, 0.55); R('diverticulitis', 'crp', CRP_HI, 0.85, 0.60); R('diverticulitis', 'ct', ['diverticulitis', 'abscess'], 0.95, 0.96, { key: true });
  R('diverticulitis', 'gi_bleed', ['hematochezia'], 0.08, 0.95); R('diverticulitis', 'rebound_guarding', null, 0.30, 0.78); R('diverticulitis', 'diarrhea', null, 0.25, 0.65);
  // 感染性腸炎
  R('gastroenteritis', 'diarrhea', ['watery'], 0.85, 0.60, { key: true }); R('gastroenteritis', 'diarrhea', null, 0.95, 0.55); R('gastroenteritis', 'vomiting', null, 0.60, 0.55); R('gastroenteritis', 'nausea', null, 0.70, 0.45);
  R('gastroenteritis', 'sick_contact_food', null, 0.40, 0.92); R('gastroenteritis', 'travel', null, 0.10, 0.97); R('gastroenteritis', 'abd_pain', ['diffuse', 'umb'], 0.70, 0.55); R('gastroenteritis', 'pain_char', ['colicky'], 0.60, 0.70);
  R('gastroenteritis', 'temp', FEV, 0.40, 0.65); R('gastroenteritis', 'bowel_sounds', ['hyper'], 0.50, 0.85); R('gastroenteritis', 'rebound_guarding', null, 0.03, 0.75);
  R('gastroenteritis', 'wbc', ['gt15'], 0.08, 0.80); R('gastroenteritis', 'crp', ['gt10'], 0.05, 0.85); R('gastroenteritis', 'dehydration_signs', null, 0.30, 0.82); R('gastroenteritis', 'ct', ['normal'], 0.80, 0.60);
  // 細菌性腸炎（血性）
  R('bacterial_colitis', 'diarrhea', ['bloody', 'mucous'], 0.80, 0.92, { key: true }); R('bacterial_colitis', 'temp', HIFEV, 0.60, 0.70); R('bacterial_colitis', 'crp', CRP_VHI, 0.60, 0.75);
  R('bacterial_colitis', 'sick_contact_food', null, 0.40, 0.92); R('bacterial_colitis', 'stool_test', ['culture_pos'], 0.60, 0.98, { key: true }); R('bacterial_colitis', 'abd_pain', ['llq', 'diffuse', 'umb'], 0.80, 0.50);
  R('bacterial_colitis', 'pain_char', ['colicky'], 0.60, 0.70); R('bacterial_colitis', 'rebound_guarding', null, 0.08, 0.75); R('bacterial_colitis', 'ct', ['colitis'], 0.60, 0.92);
  // C. difficile
  R('cdiff', 'recent_abx', null, 0.80, 0.88, { key: true }); R('cdiff', 'hospitalized_recent', null, 0.50, 0.88); R('cdiff', 'diarrhea', ['watery', 'mucous'], 0.90, 0.60); R('cdiff', 'wbc', ['gt15'], 0.40, 0.85);
  R('cdiff', 'stool_test', ['cdiff_pos'], 0.90, 0.98, { key: true }); R('cdiff', 'temp', FEV, 0.40, 0.65); R('cdiff', 'abd_pain', ['diffuse', 'llq'], 0.60, 0.55); R('cdiff', 'ct', ['colitis'], 0.50, 0.92);
  // IBD
  R('ibd_flare', 'ibd_hx', null, 0.70, 0.97, { key: true }); R('ibd_flare', 'diarrhea', ['bloody', 'mucous'], 0.70, 0.88); R('ibd_flare', 'weight_loss', null, 0.40, 0.92); R('ibd_flare', 'crp', CRP_HI, 0.70, 0.60);
  R('ibd_flare', 'hb', ['low'], 0.40, 0.85); R('ibd_flare', 'ct', ['colitis'], 0.60, 0.92); R('ibd_flare', 'abd_pain', ['llq', 'rlq', 'diffuse'], 0.80, 0.50);
  // 虚血性大腸炎
  R('ischemic_colitis', 'abd_pain', ['llq', 'diffuse'], 0.85, 0.55); R('ischemic_colitis', 'gi_bleed', ['hematochezia'], 0.80, 0.93, { key: true }); R('ischemic_colitis', 'pain_onset_char', ['sudden', 'rapid'], 0.60, 0.75);
  R('ischemic_colitis', 'cv_risk', null, 0.75, 0.45); R('ischemic_colitis', 'af_vascular', null, 0.30, 0.88); R('ischemic_colitis', 'ct', ['colitis'], 0.75, 0.92, { key: true }); R('ischemic_colitis', 'diarrhea', ['bloody'], 0.60, 0.92);
  R('ischemic_colitis', 'tender_llq', null, 0.70, 0.78); R('ischemic_colitis', 'lactate', ['2_4', 'gt4'], 0.25, 0.88);
  // 嵌頓ヘルニア
  R('incarcerated_hernia', 'hernia_hx', null, 0.60, 0.92); R('incarcerated_hernia', 'hernia_irreducible', null, 0.92, 0.99, { key: true }); R('incarcerated_hernia', 'obstipation', null, 0.50, 0.85);
  R('incarcerated_hernia', 'vomiting', null, 0.60, 0.55); R('incarcerated_hernia', 'ct', ['hernia', 'sbo'], 0.90, 0.96, { key: true }); R('incarcerated_hernia', 'abd_pain', ['rlq', 'llq', 'supra', 'diffuse'], 0.85, 0.50);
  R('incarcerated_hernia', 'distension', null, 0.50, 0.75);
  // DKA
  R('dka', 'diabetes', null, 0.92, 0.88, { key: true }); R('dka', 'glucose', ['gt250'], 0.98, 0.92, { key: true }); R('dka', 'acidosis', ['metabolic'], 0.95, 0.92, { key: true }); R('dka', 'vomiting', null, 0.75, 0.55);
  R('dka', 'abd_pain', ['diffuse', 'epi'], 0.60, 0.55); R('dka', 'rr', ['gt24'], 0.55, 0.88); R('dka', 'dehydration_signs', null, 0.65, 0.82); R('dka', 'consciousness', ['altered'], 0.20, 0.97);
  // 中毒性巨大結腸症
  R('toxic_megacolon', 'distension', null, 0.90, 0.75, { key: true }); R('toxic_megacolon', 'diarrhea', ['bloody', 'mucous', 'watery'], 0.85, 0.60); R('toxic_megacolon', 'ibd_hx', null, 0.40, 0.97);
  R('toxic_megacolon', 'recent_abx', null, 0.30, 0.88); R('toxic_megacolon', 'temp', HIFEV, 0.80, 0.70); R('toxic_megacolon', 'hr', TACHY, 0.85, 0.65); R('toxic_megacolon', 'xray', ['dilated_loops'], 0.85, 0.88, { key: true });
  R('toxic_megacolon', 'ct', ['colitis'], 0.85, 0.92, { key: true }); R('toxic_megacolon', 'wbc', ['gt15'], 0.60, 0.80); R('toxic_megacolon', 'consciousness', ['altered'], 0.20, 0.97); R('toxic_megacolon', 'sbp', HYPO, 0.30, 0.90);
  // 精巣捻転
  R('testicular_torsion', 'scrotal_pain', null, 0.90, 0.98, { key: true }); R('testicular_torsion', 'scrotal_exam', ['tender_swollen'], 0.92, 0.98, { key: true }); R('testicular_torsion', 'abd_pain', ['supra', 'rlq', 'llq'], 0.60, 0.50);
  R('testicular_torsion', 'vomiting', null, 0.50, 0.55); R('testicular_torsion', 'pain_onset_char', ['sudden'], 0.75, 0.82);
  // 非特異的腹痛/便秘
  R('nonspecific_ap', 'abd_pain', null, 0.90, 0.20); R('nonspecific_ap', 'rebound_guarding', null, 0.02, 0.75); R('nonspecific_ap', 'rigidity', null, 0.005, 0.97); R('nonspecific_ap', 'temp', HIFEV, 0.03, 0.70);
  R('nonspecific_ap', 'wbc', ['gt15'], 0.04, 0.80); R('nonspecific_ap', 'crp', ['lt1'], 0.75, 0.55); R('nonspecific_ap', 'obstipation', null, 0.30, 0.85); R('nonspecific_ap', 'ct', ['normal'], 0.90, 0.60, { key: true });
  R('nonspecific_ap', 'us', ['normal'], 0.85, 0.55); R('nonspecific_ap', 'hr', ['gt120'], 0.02, 0.90); R('nonspecific_ap', 'sbp', ['lt90'], 0.005, 0.95); R('nonspecific_ap', 'vomiting', null, 0.25, 0.55);
  // 脱水（併存）
  R('dehydration', 'dehydration_signs', null, 0.80, 0.82, { key: true }); R('dehydration', 'hr', TACHY, 0.65, 0.65); R('dehydration', 'renal', ['elevated'], 0.55, 0.88); R('dehydration', 'diarrhea', null, 0.70, 0.60);
  R('dehydration', 'vomiting', null, 0.65, 0.55); R('dehydration', 'sbp', HYPO, 0.30, 0.90); R('dehydration', 'consciousness', ['altered'], 0.10, 0.97);

  KB.relations = REL;
  KB.relByDisease = {}; KB.relByFeature = {};
  for (const r of REL) { (KB.relByDisease[r.d] = KB.relByDisease[r.d] || []).push(r); (KB.relByFeature[r.f] = KB.relByFeature[r.f] || []).push(r); }

  /* ---------- Safety rules v0.1（宣言的。評価はSafety Engine） ---------- */
  KB.rulesVersion = 'safety-0.1.0';
  // helpers used by rule 'when' are evaluated by Safety Engine with a small DSL:
  //  {f:'sbp', in:['lt90']} / {f:'rigidity', present:true} / {ctx:'sex', is:'female'} / all:[...] / any:[...]
  KB.safetyRules = [
    { id: 'S01', level: 'emergent', label: 'ショック/循環不全の可能性', when: { any: [{ f: 'sbp', in: ['lt90'] }, { all: [{ f: 'hr', in: ['gt120'] }, { f: 'sbp', in: ['lt90', '90_100'] }] }] },
      message: '通常ランキングより先に蘇生・原因検索（出血/敗血症/心原性）。乳酸・Hb・意識・尿量を直ちに確認。', force_next: ['lactate', 'hb', 'consciousness', 'ecg'] },
    { id: 'S02', level: 'emergent', label: '意識変容', when: { f: 'consciousness', in: ['altered'] }, message: '敗血症・ショック・DKA・出血を想定。血糖・血液ガス・乳酸を直ちに。', force_next: ['glucose', 'acidosis', 'lactate', 'sbp'] },
    { id: 'S03', level: 'warning', label: '呼吸状態の悪化', when: { any: [{ f: 'spo2', in: ['lt94'] }, { f: 'rr', in: ['gt24'] }] }, message: '敗血症・アシドーシス・腹腔内病変の胸腔波及を考慮。血液ガスを検討。', force_next: ['acidosis'] },
    { id: 'S04', level: 'emergent', label: '高乳酸血症', when: { f: 'lactate', in: ['gt4'] }, message: '組織低灌流。腸間膜虚血・敗血症・穿孔を最優先で評価。造影CT・外科相談。', force_next: ['ct', 'sbp'] },
    { id: 'S05', level: 'emergent', label: '腹膜炎/free airの所見', when: { any: [{ f: 'rigidity', present: true }, { f: 'xray', in: ['free_air'] }, { f: 'ct', in: ['free_air'] }] }, message: '消化管穿孔として外科へ直ちに連絡。絶食・輸液・抗菌薬を検討。', force_next: ['sbp', 'hr', 'lactate'] },
    { id: 'S06', level: 'emergent', label: '拍動性腫瘤＋腹痛', when: { f: 'pulsatile_mass', present: true }, message: 'AAA破裂を想定。バイタル不安定なら画像を待たず血管外科。安定なら即時US/CT。', force_next: ['sbp', 'us', 'ct'] },
    { id: 'S07', level: 'path', label: '妊娠反応陽性の腹痛', when: { all: [{ f: 'hcg', in: ['pos'] }, { ctx: 'sex', is: 'female' }] }, message: '異所性妊娠を除外するまで専用経路（経腟超音波・産婦人科）。', force_next: ['us', 'sbp', 'hb'] },
    { id: 'S08', level: 'emergent', label: '消化管出血＋頻脈', when: { all: [{ any: [{ f: 'gi_bleed', present: true }, { f: 'vomiting', in: ['hematemesis', 'coffee_ground'] }, { f: 'rectal_blood', present: true }] }, { f: 'hr', in: TACHY }] },
      message: '循環血液量減少を伴う出血。Hb・輸血準備・内視鏡/血管内治療の連絡。', force_next: ['hb', 'sbp', 'anticoag'] },
    { id: 'S09', level: 'emergent', label: '腸間膜虚血を強く示唆', when: { all: [{ f: 'pain_disproportion', present: true }, { any: [{ f: 'af_vascular', present: true }, { f: 'lactate', in: ['2_4', 'gt4'] }] }] },
      message: '時間依存性に致死率上昇。造影CTと血管外科/消化器外科へ。', force_next: ['ct', 'lactate'] },
    { id: 'S10', level: 'emergent', label: '還納不能ヘルニア', when: { f: 'hernia_irreducible', present: true }, message: '嵌頓/絞扼ヘルニア。外科へ直ちに。', force_next: ['ct', 'lactate'] },
    { id: 'S11', level: 'emergent', label: '陰嚢の圧痛/腫脹', when: { all: [{ f: 'scrotal_exam', in: ['tender_swollen'] }, { ctx: 'sex', is: 'male' }] }, message: '精巣捻転は6時間が勝負。泌尿器科へ直ちに（超音波ドプラ）。', force_next: [] },
    { id: 'S12', level: 'emergent', label: '高血糖＋アシドーシス', when: { all: [{ f: 'glucose', in: ['gt250'] }, { f: 'acidosis', in: ['metabolic'] }] }, message: 'DKAとして治療開始。腹痛は DKA 自体で説明され得るが外科疾患の併存も除外。', force_next: ['consciousness', 'renal'] },
    { id: 'S13', level: 'warning', label: 'qSOFA 2項目以上（敗血症疑い）', when: { count2: [{ f: 'rr', in: ['gt24', '21_24'] }, { f: 'consciousness', in: ['altered'] }, { f: 'sbp', in: ['lt90', '90_100'] }] },
      message: '敗血症バンドル（培養・乳酸・抗菌薬・輸液）を検討。感染源として胆道・尿路・腸管・腹腔内を評価。', force_next: ['lactate', 'temp', 'wbc'] },
    { id: 'S14', level: 'warning', label: '高熱＋低血圧傾向', when: { all: [{ f: 'temp', in: ['ge39'] }, { f: 'sbp', in: HYPO }] }, message: '敗血症性ショックの前段階の可能性。', force_next: ['lactate'] },
    { id: 'S15', level: 'warning', label: '免疫抑制状態', when: { f: 'immunosupp', present: true }, message: '所見が乏しくても重症化し得る。閾値を下げて画像・血液培養を考慮。', force_next: [] },
    { id: 'S16', level: 'warning', label: '抗凝固薬使用中', when: { f: 'anticoag', present: true }, message: '腹直筋血腫・後腹膜出血・消化管出血を鑑別に加える。', force_next: ['hb'] }
  ];
  // 適用外/専用経路（context）
  KB.scopeRules = [
    { id: 'X01', status: 'out_of_scope', when: { ctx: 'age_band', is: 'lt18' }, message: '小児は本パックの対象外です（小児用パック未実装）。' },
    { id: 'X02', status: 'out_of_scope', when: { ctx: 'trauma', is: 'yes' }, message: '外傷性腹痛は対象外です（外傷初期診療の手順に従ってください）。' },
    { id: 'X03', status: 'special_path', when: { ctx: 'pregnancy', is: 'confirmed' }, message: '妊娠中の腹痛は専用経路（産科と連携）。本パックの順位は参考表示に留めます。' }
  ];
  // 前提/必須取得（force_next 用）
  KB.prerequisiteRules = [
    { id: 'P01', label: '妊娠可能性のある女性では hCG を画像より先に', when: { all: [{ ctx: 'sex', is: 'female' }, { ctx: 'age_max', is: '40-49' }, { ctx: 'pregnancy_not', is: 'no' }, { f: 'hcg', unobserved: true }] }, force_next: ['hcg'] },
    { id: 'P02', label: 'バイタル未取得', when: { all: [{ f: 'sbp', unobserved: true }, { f: 'hr', unobserved: true }] }, force_next: ['sbp', 'hr', 'temp'] }
  ];
  // 矛盾検出
  KB.contradictionRules = [
    { id: 'C01', when: { all: [{ f: 'obstipation', present: true }, { f: 'diarrhea', present: true }] }, message: '「排ガス・排便停止」と「下痢」が同時に入力されています。' },
    { id: 'C02', when: { all: [{ f: 'abd_pain', absent: true }, { any: [{ f: 'rebound_guarding', present: true }, { f: 'tender_rlq', present: true }, { f: 'tender_epi', present: true }] }] }, message: '「腹痛なし」と圧痛/腹膜刺激徴候ありが併存しています。' },
    { id: 'C03', when: { all: [{ f: 'hcg', in: ['pos'] }, { ctx: 'pregnancy', is: 'no' }] }, message: '妊娠可能性なしの設定で hCG 陽性が入力されています。' },
    { id: 'C04', when: { all: [{ f: 'hcg', in: ['pos'] }, { ctx: 'sex', is: 'male' }] }, message: '男性で hCG 陽性が入力されています。' },
    { id: 'C05', when: { all: [{ f: 'bowel_sounds', in: ['absent'] }, { f: 'bowel_sounds', in: ['hyper'] }] }, message: '腸蠕動音が消失と亢進で重複しています。' }
  ];

  KB.evidence = [
    { id: 'E0', citation: 'v0.1 専門家ドラフト（未承認）。感度/特異度は一般的教科書・系統的レビューの近似値。', approval_status: 'draft' }
  ];

  g.DDX = g.DDX || {};
  g.DDX.KB = KB;
})(typeof window !== 'undefined' ? window : globalThis);
