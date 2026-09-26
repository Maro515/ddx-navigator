# 本文確認待ち文献 — 調査チェックリスト（12件）

各文献について **①統合 N（対象患者数）** と **②所見ごとの 感度・特異度（または LR+ / LR−）と閾値定義** を本文の表から転記してください。
LR しか無い場合は LR+ と LR− の両方があれば感度/特異度に復元できます。片方しか無い場合はそのまま記載してください。

記入フォーマット（1 行 1 所見。この形式で送っていただければそのまま台帳へ取り込みます）:

```
PMID | 統合N | 所見（本文の表記） | 閾値/定義 | 感度 | 特異度 | LR+ | LR− | 備考（研究数・対象集団）
```

---

## A. 虫垂炎

### 1. Wagner JM, McKinney WP, Carpenter JL. Does this patient have appendicitis? JAMA 1996;276:1589-94
- PMID 8918857 — https://pubmed.ncbi.nlm.nih.gov/8918857/
- ①統合 N（採用研究数と患者数）
- ②本文 Table の各所見: 右下腹部痛、痛みの移動（臍周囲→RLQ）、食欲低下、嘔気、嘔吐、右下腹部圧痛、反跳痛、筋性防御、板状硬、psoas 徴候、Rovsing 徴候、発熱（**閾値 ℃**）
- 本アプリ対応: abd_pain[rlq], pain_char[migrating_rlq], anorexia, nausea, vomiting, tender_rlq, rebound_guarding, rigidity, psoas_obturator, temp

### 2. Andersson REB. Meta-analysis of the clinical and laboratory diagnosis of appendicitis. Br J Surg 2004;91:28-37
- PMID 14716790 — DOI 10.1002/bjs.4464
- ①統合 N（24 研究の合計患者数）
- ②所見別の統合 LR+/LR−（または ROC 面積）: 反跳痛、筋性防御、板状硬、直接圧痛（RLQ）、痛みの移動、発熱（閾値）、WBC（**閾値: 10,000? 15,000?**）、CRP（**閾値 mg/L**）、好中球比率
- 本アプリ対応: rebound_guarding, rigidity, tender_rlq, pain_char[migrating_rlq], temp, wbc, crp

## B. 胆嚢炎

### 3. Trowbridge RL, Rutkowski NK, Shojania KG. Does this patient have acute cholecystitis? JAMA 2003;289:80-6
- PMID 12503981 — DOI 10.1001/jama.289.1.80
- ①統合 N（17 研究）
- ②Murphy 徴候（抄録: LR+ 2.8 のみ。**感度・特異度・LR− を確認**）、右上腹部圧痛（抄録: LR− 0.4）、発熱（閾値）、右上腹部痛、嘔気/嘔吐、白血球増多、ビリルビン
- 本アプリ対応: murphy, tender_ruq, temp, abd_pain[ruq], vomiting, wbc, bili

### 4. Jain A, et al. History, Physical Examination, Laboratory Testing, and Emergency Department Ultrasonography for the Diagnosis of Acute Cholecystitis. Acad Emerg Med 2017;24:281-97
- PMID 27862628 — DOI 10.1111/acem.13132
- ①病歴/診察を統合した 3 研究の合計 N、検査・US 研究の合計 N
- ②Murphy 徴候（抄録: 感度 0.62 / 特異度 0.96 / LR+ 15.6 / LR− 0.40 — **N を確認**）、発熱、右上腹部痛、白血球、ビリルビン、救急超音波
- 本アプリ対応: murphy, temp, abd_pain[ruq], wbc, bili, us[gb]

## C. 腸閉塞

### 5. Taylor MR, Lalani N. Adult small bowel obstruction. Acad Emerg Med 2013;20:528-44
- PMID 23758299 — DOI 10.1111/acem.12150
- ①統合 N
- ②病歴・診察: 腹部膨満、腸音異常（亢進/減弱の別）、腹部手術歴、便秘/排ガス停止、嘔吐；画像: 単純 X 線、CT、超音波 — 各 感度/特異度/LR
- 本アプリ対応: distension, bowel_sounds, prior_abd_surgery, obstipation, vomiting, xray, ct

## D. 血管

### 6. Lederle FA, Simel DL. Does this patient have abdominal aortic aneurysm? JAMA 1999;281:77-82
- PMID 9892455 — DOI 10.1001/jama.281.1.77
- ①統合 N（15 スクリーニング研究）
- ②腹部触診の 感度（径 3.0-3.9 / 4.0-4.9 / ≥5.0 cm 別）、特異度、LR+ 12.0 / LR− 0.72（≥3 cm）を確認。**未破裂スクリーニング集団である点を備考に**
- 本アプリ対応: pulsatile_mass（破裂 AAA の relation。破裂例は別途 Acad Emerg Med 2022 メタ解析で感度 0.471 採用済み）

### 7. Klompas M. Does this patient have an acute thoracic aortic dissection? JAMA 2002;287:2262-72
- PMID 11980527 — DOI 10.1001/jama.287.17.2262
- ①統合 N（21 研究）
- ②突然発症、引き裂かれるような痛み、脈拍欠損/血圧左右差（LR+ 5.7）、局所神経症状、高血圧の割合、低血圧/ショックの割合、拡張期雑音、縦隔拡大 — 各 感度/LR
- 本アプリ対応: pain_onset_char[sudden], sbp（lt90 / gt140）, chest_sx, syncope

## E. 冠症候群

### 8. Bruyninckx R, et al. Signs and symptoms in diagnosing acute myocardial infarction and acute coronary syndrome: a diagnostic meta-analysis. Br J Gen Pract 2008;58:105-11
- PMID 18307844 — DOI 10.3399/bjgp08X277014
- ①統合 N（28 研究）
- ②発汗（LR+ 2.92）、胸壁圧痛（存在時の LR、抄録では「なし」の LR− 0.23）、嘔気/嘔吐、放散痛、蒼白 — 各 感度/特異度/LR
- 本アプリ対応: skin_pallor_cold, tender_epi, nausea, vomiting

### 9. Swap CJ, Nagurney JT. Value and limitations of chest pain history in the evaluation of patients with suspected acute coronary syndromes. JAMA 2005;294:2623-9
- PMID 16304077 — DOI 10.1001/jama.294.20.2623
- ①統合 N
- ②触診で再現される痛み（LR 0.2-0.3 の範囲 → 点推定値）、両腕への放散、労作時、発汗、嘔気/嘔吐 — 各 LR
- 本アプリ対応: tender_epi, chest_sx

## F. 泌尿器・脱水

### 10. Bent S, et al. Does this woman have an acute uncomplicated urinary tract infection? JAMA 2002;287:2701-10
- PMID 12020306 — DOI 10.1001/jama.287.20.2701
- ①統合 N（9 研究）
- ②CVA 叩打痛（LR+ 1.7、LR− も）、排尿時痛、頻尿、血尿、背部痛、帯下 — 各 LR+/LR−。**対象は女性の単純性 UTI（腎盂腎炎ではない）点を備考に**
- 本アプリ対応: cva_tender, dysuria

### 11. McGee S, Abernethy WB, Simel DL. Is this patient hypovolemic? JAMA 1999;281:1022-9
- PMID 10086438 — DOI 10.1001/jama.281.11.1022
- ①統合 N（14 研究）
- ②腋窩乾燥（LR+ 2.8）、口腔粘膜乾燥/湿潤（LR− 0.3）、舌の溝、眼窩陥凹、毛細血管再充満、ツルゴール、体位性脈拍増加 ≥30/分、臥位低血圧 — 各 感度/特異度/LR。**出血モデル（瀉血）か臨床脱水かを備考に**
- 本アプリ対応: dehydration_signs, hr, sbp

## G. 精巣捻転

### 12. Edwards et al. BET: in emergency settings, can an absent cremasteric reflex be used to aid diagnosis of testicular torsions? Emerg Med J 2025
- PMID 40537283 — DOI 10.1136/emermed-2024-214797
- ①採用 13 論文それぞれの N（**N ≥ 300 のものがあればその論文の PMID**）
- ②挙睾筋反射消失の 感度/特異度（論文別）
- 本アプリ対応: scrotal_exam（現在は日本の TWIST 研究 Nakamura 2026 を採用済み。補強用）

---

## 優先順位（影響の大きい順）
1. Wagner 1996（虫垂炎の所見 9 項目が一度に埋まる）
2. Trowbridge 2003 / Jain 2017（Murphy 徴候・右上腹部圧痛）
3. Andersson 2004（反跳痛・筋性防御・板状硬の統合 LR）
4. Taylor 2013（腸閉塞の膨満・腸音・X線）
5. McGee 1999（脱水所見）
6. その他

## 注意
- 数値は本文の表から転記し、閾値（発熱の ℃、WBC/CRP の値）を必ず添えてください。本アプリのバケットと異なる閾値でも構いません（備考に残します）。
- 統合 N が本文にも無い場合は「N 記載なし」と書いてください。その文献は数値を採用せず参照扱いのままにします。
