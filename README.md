# DDx Navigator — 逐次・動的鑑別診断支援（腹痛/下痢パック v0.1）

計画書 `Sequential_Diagnostic_Support_Plan_v1_0_JA.md` の **Phase 1 Baseline MVP** 実装。
単一ファイル `index.html`（オフライン動作・ビルド不要・外部通信なし※Jev remote 設定時のみ送信）。

## 起動
- 公開版（GitHub Pages）: https://maro515.github.io/ddx-navigator/ （`main` の `index.html` をそのまま配信。音声入力・書き出しも使える）
- 公開版（Artifact）: https://claude.ai/artifact/PiJ63YtsRRdiyKjEw2Rjcu （`dist/artifact.html` を再公開で更新。ビューア内ではファイル書き出しが無効）
- `index.html` をブラウザで開く（スマホなら「ホーム画面に追加」でアプリ様に動作）
- 開発プレビュー: ルートの `.claude/launch.json` の `ddx-navigator`（port 9021）

## 構成（モジュール分離）
| ファイル | 責任 |
|---|---|
| `build/10_kb.js` | Medical Knowledge DB：FeatureDefinition 82 / Disease 29 / DiseaseFeatureRelation 298（sens/spec）/ AcquisitionMetadata / 時間バケット / freshness / SafetyRule / scope / prerequisite / contradiction |
| `build/20_state.js` | Clinical State Engine：Observation 正規化、順序非依存の current 決定（同一 feature は時間が新しい方）、履歴、freshness、canonical hash |
| `build/30_safety.js` | Safety Engine：緊急条件・専用経路・適用外・前提（hCG先行/バイタル未取得）・矛盾。Jev/LLM より先に評価 |
| `build/40_ddx.js` | Differential Engine：適用判定→事前確率×LR→時間整合→Likely Top10（適合 高/中/低、%非表示）と Must-not-miss（要注意/未除外/概ね除外）を独立生成 |
| `build/50_next.js` | Next-Item Engine：**エマージェンシー枠**（候補に挙がった重大疾患を個別に除外。除外チェックリスト・最短除外・同時除外の推奨順）と**鑑別枠**（可能性順 Top10 の絞り込み、EIG ベース）を分離。EIG（エントロピー減少）+管理影響+MNM解除価値+緊急性(+Jev)−費用−侵襲−待ち−重複。Safety forced が常に上位。Jev アダプタ（none/mock/remote） |
| `build/60_audit.js` | 監査ログ（版・state hash・Top10・Next5・安全フラグ・Jev状態）、`DDX.run` パイプライン |
| `build/65_extract.js` | フリーテキスト → 構造化。**PII 除去**（氏名・ID・日付・電話・住所・メール・生年月日・正確な年齢→年齢帯）→ **LLM 抽出**（Claude Messages API をブラウザから直接呼び出し、tool use `record_findings` で JSON 強制、カタログ外は捨てる）→ **ローカル抽出**（日本語ルール、数値閾値、否定判定。API 不可時の fallback、バイタル/検査値は常に補完） |
| `build/19_labs.js` | 検査値パネルの項目定義（血算: WBC/Hb/Plt、生化学: CRP/AST/ALT/ALP/γ-GTP/T-Bil/アミラーゼ/リパーゼ/BUN/Cre/Na/K/Cl/血糖/乳酸/CK/LDH/D-dimer/hs-TnT/CK-MB/BNP/NT-proBNP/Ca/P/Mg/アンモニア、尿定性は選択式）。Hb は男性 <13 / 女性 <12 で低下。単位・基準値は国立がん研究センター中央病院「検査基準値一覧」（https://www.ncc.go.jp/jp/ncch/division/clinical_laboratory/kensa.pdf）に準拠（WBC 10³/μL、Plt 10⁴/μL、Na/K/Cl mmol/L、ALP は JSCC 法 106～322、トロポニンは TnI ng/mL 0.03 以下 など）。数値→KB 値コードの閾値はここで定義（異常の判定は臨床的カットオフ: 低Na <135、高K >5.5、低K <3.5、高Ca >10.5、Plt <15。CK/LD/アンモニアは基準上限超）。`DDX.LABS.resolve` が入力済みの全検査値から所見を作り、同じ項目に書く検査（AST/ALT など）は最も異常な値を採る。AST と ALT が揃えば AST/ALT パターンも付ける。対応 feature の無い項目（Cl/P/Mg/CK-MB/BNP）は入力欄にテキストで残す |
| `build/75_ui_simple.js` | 簡素UI 3画面（入力 / 結果 / 設定）。大きな文字、音声入力（Web Speech API、テキスト欄右下の🎤）、人体図は部位名の挿入のみ。🧪検査値は一覧→電卓キーパッドで数値入力し即登録。結果は「先に確認」「まず除外」「可能性の高い順」「次に聞く・調べる」で、質問はタップで即答 |
| `build/_legacy/70_ui.js` | 旧・選択式UI（assemble 対象外） |
| `build/15_demo.js` | デモ症例（フリーテキストのメモを順に投入） |
| `build/18_bodymap.js` | 人体イラスト（`build/assets/body.png` を base64 埋込、229×450）。前面図＋左右反転の背面図。Level1（前面: 頭部/頸部/胸部/腹部/骨盤・鼠径/上肢/下肢、背面: 頭部/頸部/背部/臀部/上肢/下肢）→ Level2 細部（左鎖骨下、右前頸部、右腰背、仙骨部、足底部 など 15 セット）。新UIでは部位名を入力欄に挿入する用途のみ（複数選択 → 確定で「右下腹部・心窩部に」と挿入） |
| `tests/run_tests.js` | 回帰テスト：合成症例 224 件の Top-k recall、入力順序不変性、欠損区別、矛盾、ノイズ耐性、時間境界、Safety、MNM解除、Jev障害 fallback、KB整合性 |

## AI 解析の設定
設定 > AI 解析 に Anthropic API キーを入れると、除去後の本文がブラウザから直接 `https://api.anthropic.com/v1/messages` に送られます（既定モデル `claude-opus-5-5`（Opus 5 / Sonnet 5 / Haiku 4.5 に変更可））。キー未設定・通信不可・拒否時はローカル解析に自動で切り替わります。送信前に除去後の文面を確認する画面が出ます（設定でスキップ可）。
音声入力は Chrome/Safari の通常ブラウザで動作します（Artifact ビューア内ではマイクが使えません）。

## 開発コマンド
```bash
python3 assemble.py        # build/* → index.html
node tests/run_tests.js    # 回帰テスト
```

## Jev アダプタ（リモート）
`設定 > Jev > リモート` にエンドポイントと API キーを設定。送信 JSON（最小 state）:
```json
{ "case_token": "...", "care_context": {"age_band":"60-69","sex":"male","setting":"emergency"},
  "current_top_diseases": [{"id":"appendicitis","label":"急性虫垂炎","fit":"high"}],
  "must_not_miss_open": [{"id":"perforation","label":"消化管穿孔"}],
  "observed_features": [{"feature":"abd_pain","value":"rlq","status":"present","elapsed":"hours","severity":"severe"}],
  "candidate_features": [{"feature":"us","label":"腹部超音波","type":"imaging"}],
  "questions": ["relevant_to_separating_top_diseases","could_change_near_term_management","already_represented","urgency_now"] }
```
期待する応答: `{"results":[{"feature":"us","relevant":true,"relevance":0.8,"confidence":0.9}]}`。
confidence < 0.5 は無視（gate）。障害時は baseline に自動 fallback し、ヘッダに「停止中」と表示。
TypeSafe/Jev の実 API 仕様に合わせるには `DDX.Jev.remote()` と `buildPayload()` を差し替える。

## 疾患カバレッジ
- コア（腹痛/下痢パック v0.2）: 30 疾患。文献値・専門家ドラフト値
- 拡張パック（腹部症状）: 184 疾患（上部消化管・肝胆膵・下部消化管・血管・婦人科・泌尿器・全身/代謝・胸部/その他・腹壁/ヘルニア）。妊娠中限定疾患は `requires.pregnancy_in`、性別は解剖学的限定のみ hard、それ以外は事前確率 ×1.5 の soft
- 合成テストの Top10 recall: コア 94%、拡張 75%（有病率で重み付けすると Top10 91%）（拡張はドラフト値のため要レビュー）
- 症例問題集（220 問）での評価: `node tools/eval_qbank.js <問題集.md>`。方法と結果は `docs/qbank_evaluation.md`（改善前 Top5 48% → 最終 95.5%。新しい症例への見積もりは取り分けた検証用で 45% → 63%）。問題集はリポジトリに含めない
- 有病率: 拡張疾患の事前確率は `tools/prevalence.json`（腹部症状を伴う受診発症数/10万人年の概算 × 0.001）から `python3 tools/build_prevalence.py` で `build/13_prevalence.js` を生成。所見の尤度差が 3 倍以内の疾患は有病率順、診断的所見（`tools/feature_defs.json` の `diagnostic`）は尤度比上限 1万
- 所見項目の重複整理: `docs/feature_dedup_candidates.md`（2026-09-27 承認・反映）。統合・分解は `tools/feature_alias.json`（`expand` で 1 対多、値マップは値リスト・`=` 恒等・`@項目`・`null` に対応）、項目の上書き・値の追加・関係の追加/削除は `tools/feature_defs.json`。一方の入力から他方を立てる自動導出（心電図AF→既往AF、糖尿病→冠危険因子、妊娠時期→妊娠状態 など）は `build/20_state.js` の `DERIVE`

## 根拠ポリシー（EvidenceSource）
- 一次文献（査読論文・系統的レビュー・学会ガイドライン）、**2016年以降**、**N ≥ 300**
- **例外**: 古典的な身体所見（診察所見・バイタル）は年代を限定せず、N が最大の文献を採用（日本/アジアに無ければ米欧）。台帳では `classic: true` で明示。2026-09-25 のオーナー承認により、転記済み古典文献の問診・検査項目も採用可（`classic_any_type`）
- 母集団の優先順位: **日本 > アジア > 世界**（同一 relation に複数文献がある場合はこの順、次に N の大きい順で採用）
- すべて **PMID/DOI** を持ち、UI の疾患カード「根拠文献」および 設定 > 根拠台帳 から原文へ辿れる
- 台帳は `build/12_evidence.js`（2026-09-25 時点: 文献 107 件＋参照ガイドライン 11 件。感度+特異度を文献値で上書き 21 関係、感度のみ 17、参照付き 67 / 全 299）。`KB.applyEvidence()` が relation の sens/spec を文献値で上書きし、文献の無い relation は v0.1 ドラフト値のまま `draft: true`（UI に「根拠未付与」と表示）
- 抄録に AUC/OR しか無い文献、複合スコア（TWIST/STONE/ADD-RS 等）、重症度予測が目的の研究、対象集団が非典型な研究は `ref_only`/`composite` として参照のみ（数値は上書きしない）
- 学会ガイドライン（TG18、JPN膵炎2021、JSGE消化性潰瘍2020 等）は `KB.guidelines` に別枠で保持（N 要件の対象外、PMID 必須）
- 疾患カードでは ✅=数値に採用、📄=参照のみ、📘=ガイドライン
- `KB.pendingEvidence`: 古典的所見の代表文献（JAMA Rational Clinical Examination 等）で統合 N・所見別数値が本文にしかないもの。原文確認後に `KB.evidence` へ昇格させる（設定 > 根拠台帳 > 本文確認待ち）
- UpToDate 等の購読型三次資料は台帳に載せない（規約・監査上の理由）。読んで一次文献を辿る用途に限る

## 注意
研究用プロトタイプ。医療機器承認なし。Medical DB v0.1 は専門家レビュー前のドラフトで、sens/spec は近似値。
疾患確率(%)は外部検証・較正が終わるまで表示しない設計。
