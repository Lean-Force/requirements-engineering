// 複雑システムのフィクスチャ: 架空のネット銀行「SORA銀行」。
//
// 複数ボードにまたがる現実的な USM とドメイン知識のセット。
// AI のコンテキストハンドリング(kb-* skill のオンデマンド読み・合意済みマップの
// 常時参照・ボード間の齟齬チェック)を、決定的テスト(unit)と実 LLM(eval)の
// 両方から検証する共通基盤として使う。npm run seed:complex で dev データにも
// 投入できる(cx- プレフィクスで冪等にマージ)。
//
// ボード間の関係(齟齬チェックの素材):
//   - 口座開設: eKYC で当日開設が確定(fixed)→ 他業務が「郵送で2週間」を前提にしたら齟齬
//   - 国内送金: 1,000万円超は部長承認が確定(fixed)→ 知識(送金業務規程)と同じ正
//   - 不正モニタリング: 凍結解除は役員承認が確定(fixed)
//   - 旧送金規程(2019年版)は off の資料: 旧閾値 500万・旧カットオフ 14:00 は
//     「見えてはいけない事実」として使う
//
// 事実の配置(テストの判定キー):
//   - "1,000万" … 知識(送金業務規程)+ 国内送金の確定ストーリー(両方にある)
//   - "15:00"  … 知識(送金業務規程)のみ
//   - "ISO 4217" … 知識(勘定系IF定義)のみ → チャット常時注入に混入しないことの判定に使う
//   - "500万" / "14:00" … off の旧規程のみ → どこにも現れないことの判定に使う

import { promises as fs } from "fs";
import path from "path";
import type { BoardMeta, KnowledgeCategory } from "../../contracts";
import type { StoryMap } from "../../domain";
import {
  knowledgeFile,
  readEntries,
  readSources,
  saveOriginal,
  sourcesFile,
  writeJson,
} from "../../infrastructure/context/repository";
import { COMMON_SCOPE, dataRoot } from "../../infrastructure/context/workspace";
import { saveStoryMap } from "../../infrastructure/storage";

const SEEDED_AT = "2026-07-10T00:00:00.000Z";

// ---- ボードとマップ -----------------------------------------------------------

export interface FixtureBoard {
  id: string;
  name: string;
  map: StoryMap;
}

export const BOARDS: FixtureBoard[] = [
  {
    id: "cx-onboarding",
    name: "口座開設",
    map: {
      actors: [
        { id: "cust", name: "お客様" },
        { id: "op", name: "オペレーター" },
        { id: "exam", name: "審査担当" },
        { id: "sys", name: "基幹システム" },
      ],
      activities: [
        {
          id: "ob-apply",
          flowName: "申込",
          actions: [
            {
              id: "ob-a1",
              actorId: "cust",
              text: "申込フォームに入力する",
              stories: [
                {
                  id: "ob-s1",
                  text: "お客様は、スマホだけで口座開設を申し込みたい。なぜなら店舗に行く時間がないからだ。",
                },
              ],
            },
          ],
        },
        {
          id: "ob-ekyc",
          flowName: "申込",
          actions: [
            {
              id: "ob-a2",
              actorId: "cust",
              text: "eKYC で本人確認する",
              fixed: true,
              stories: [
                {
                  id: "ob-s2",
                  text: "お客様は、eKYC で当日中に口座開設を完了したい。なぜなら郵送のやり取りを待たずにすぐ使い始めたいからだ。",
                  fixed: true,
                },
              ],
            },
          ],
        },
        {
          id: "ob-review",
          flowName: "審査",
          actions: [
            {
              id: "ob-a3",
              actorId: "op",
              text: "申込内容を確認する",
              stories: [],
            },
            {
              id: "ob-a4",
              actorId: "exam",
              text: "反社チェックを行う",
              fixed: true,
              stories: [
                {
                  id: "ob-s3",
                  text: "審査担当は、反社チェック NG を即否決にしたい。なぜなら反社会的勢力との取引遮断は法令上の義務だからだ。",
                  fixed: true,
                },
              ],
            },
          ],
        },
        {
          id: "ob-open",
          flowName: "開設",
          actions: [
            {
              id: "ob-a5",
              actorId: "sys",
              text: "口座を開設する",
              stories: [],
            },
            {
              id: "ob-a6",
              actorId: "cust",
              text: "初回ログインする",
              stories: [
                {
                  id: "ob-s4",
                  text: "お客様は、開設完了の通知からすぐアプリにログインしたい。なぜなら開設した実感を得て使い始めたいからだ。",
                },
              ],
            },
          ],
        },
        {
          id: "ob-return",
          standalone: true,
          actions: [
            {
              id: "ob-a7",
              actorId: "op",
              text: "不備を差し戻す",
              stories: [
                {
                  id: "ob-s5",
                  text: "オペレーターは、書類不備をその日のうちに差し戻したい。なぜなら開設リードタイムを延ばしたくないからだ。",
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: "cx-domestic",
    name: "国内送金",
    map: {
      actors: [
        { id: "cust", name: "お客様" },
        { id: "op", name: "オペレーター" },
        { id: "mgr", name: "部長" },
        { id: "sys", name: "基幹システム" },
      ],
      releases: [{ name: "MVP" }, { name: "フェーズ2" }],
      activities: [
        {
          id: "dm-request",
          flowName: "受付",
          actions: [
            {
              id: "dm-a1",
              actorId: "cust",
              text: "送金を依頼する",
              stories: [
                {
                  id: "dm-s1",
                  text: "お客様は、振込先を登録リストから選びたい。なぜなら口座番号の入力ミスを避けたいからだ。",
                  release: 0,
                },
                {
                  id: "dm-s2",
                  text: "お客様は、送金予約を使いたい。なぜなら給料日に合わせて自動で送りたいからだ。",
                  release: 1,
                },
              ],
            },
            {
              id: "dm-a2",
              actorId: "op",
              text: "依頼内容を確認する",
              stories: [],
            },
          ],
        },
        {
          id: "dm-check",
          flowName: "審査・承認",
          actions: [
            {
              id: "dm-a3",
              actorId: "sys",
              text: "限度額と残高をチェックする",
              stories: [
                {
                  id: "dm-s3",
                  text: "基幹システムは、限度額超過を受付時点で弾きたい。なぜなら実行段階での失敗はお客様への説明が難しいからだ。",
                  release: 0,
                },
              ],
            },
            {
              id: "dm-a4",
              actorId: "mgr",
              text: "高額送金を承認する",
              fixed: true,
              stories: [
                {
                  id: "dm-s4",
                  text: "部長は、1,000万円を超える送金を自分の承認で通したい。なぜなら送金業務規程で部長承認が必須と定められているからだ。",
                  fixed: true,
                  release: 0,
                },
              ],
            },
          ],
        },
        {
          id: "dm-exec",
          flowName: "実行・通知",
          actions: [
            {
              id: "dm-a5",
              actorId: "sys",
              text: "送金を実行する",
              stories: [],
            },
            {
              id: "dm-a6",
              actorId: "cust",
              text: "結果を確認する",
              stories: [
                {
                  id: "dm-s5",
                  text: "お客様は、着金をプッシュ通知で知りたい。なぜなら送金相手への連絡をすぐ済ませたいからだ。",
                  release: 1,
                },
              ],
            },
          ],
        },
        {
          id: "dm-recall",
          standalone: true,
          actions: [
            {
              id: "dm-a7",
              actorId: "op",
              text: "組み戻しに対応する",
              stories: [
                {
                  id: "dm-s6",
                  text: "オペレーターは、誤送金の組み戻しを依頼当日に受け付けたい。なぜなら時間が経つほど資金回収が難しくなるからだ。",
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: "cx-foreign",
    name: "外国送金",
    map: {
      actors: [
        { id: "cust", name: "お客様" },
        { id: "op", name: "オペレーター" },
        { id: "comp", name: "コンプライアンス担当" },
        { id: "dealer", name: "為替ディーラー" },
        { id: "sys", name: "基幹システム" },
      ],
      activities: [
        {
          id: "fx-request",
          flowName: "受付",
          actions: [
            {
              id: "fx-a1",
              actorId: "cust",
              text: "外国送金を依頼する",
              stories: [
                {
                  id: "fx-s1",
                  text: "お客様は、送金目的を選択式で申告したい。なぜなら自由記述だと何を書けばよいか分からないからだ。",
                },
              ],
            },
            {
              id: "fx-a2",
              actorId: "op",
              text: "必要書類を確認する",
              stories: [],
            },
          ],
        },
        // 1 場面につき同一アクターの action は 1 枚(UI の格子モデル)。
        // 同じアクターの連続作業は場面を分け、flowName で同じ流れに束ねる
        {
          id: "fx-screening",
          flowName: "コンプライアンス",
          actions: [
            {
              id: "fx-a3",
              actorId: "comp",
              text: "制裁リストと照合する",
              fixed: true,
              stories: [
                {
                  id: "fx-s2",
                  text: "コンプライアンス担当は、制裁リストにヒットした送金を全件自分の承認に回したい。なぜなら見逃しは当局処分に直結するからだ。",
                  fixed: true,
                },
              ],
            },
          ],
        },
        {
          id: "fx-purpose",
          flowName: "コンプライアンス",
          actions: [
            {
              id: "fx-a4",
              actorId: "comp",
              text: "送金目的を審査する",
              stories: [],
            },
          ],
        },
        {
          id: "fx-exec",
          flowName: "レート・実行",
          actions: [
            {
              id: "fx-a5",
              actorId: "dealer",
              text: "適用レートを確定する",
              stories: [
                {
                  id: "fx-s3",
                  text: "為替ディーラーは、カットオフまでの依頼に当日レートを適用したい。なぜならレート変動リスクを翌日に持ち越したくないからだ。",
                },
              ],
            },
            {
              id: "fx-a6",
              actorId: "sys",
              text: "SWIFT 電文を送信する",
              stories: [],
            },
            {
              id: "fx-a7",
              actorId: "op",
              text: "着金を追跡する",
              stories: [],
            },
          ],
        },
        {
          id: "fx-inbound",
          standalone: true,
          actions: [
            {
              id: "fx-a8",
              actorId: "op",
              text: "被仕向送金の照会に対応する",
              stories: [],
            },
          ],
        },
      ],
    },
  },
  {
    id: "cx-loan",
    name: "住宅ローン審査",
    map: {
      actors: [
        { id: "cust", name: "お客様" },
        { id: "exam", name: "審査担当" },
        { id: "mgr", name: "部長" },
        { id: "guar", name: "保証会社" },
      ],
      activities: [
        {
          id: "ln-pre",
          flowName: "事前審査",
          actions: [
            {
              id: "ln-a1",
              actorId: "cust",
              text: "事前審査を申し込む",
              stories: [
                {
                  id: "ln-s1",
                  text: "お客様は、物件を決める前に借入可能額を知りたい。なぜなら予算が分からないと物件を絞れないからだ。",
                },
              ],
            },
            {
              id: "ln-a2",
              actorId: "exam",
              text: "年収と信用情報を確認する",
              stories: [],
            },
          ],
        },
        {
          id: "ln-main",
          flowName: "本審査",
          actions: [
            {
              id: "ln-a3",
              actorId: "cust",
              text: "本審査書類を提出する",
              stories: [],
            },
            {
              id: "ln-a4",
              actorId: "exam",
              text: "担保を評価する",
              fixed: true,
              stories: [
                {
                  id: "ln-s2",
                  text: "審査担当は、担保評価を外部鑑定と突合したい。なぜなら評価の妥当性に説明責任があるからだ。",
                  fixed: true,
                },
              ],
            },
            {
              id: "ln-a5",
              actorId: "guar",
              text: "保証を承諾する",
              stories: [],
            },
          ],
        },
        {
          id: "ln-contract",
          flowName: "契約・実行",
          actions: [
            {
              id: "ln-a6",
              actorId: "cust",
              text: "金銭消費貸借契約を結ぶ",
              stories: [],
            },
            {
              id: "ln-a7",
              actorId: "mgr",
              text: "融資実行を承認する",
              stories: [
                {
                  id: "ln-s3",
                  text: "部長は、融資実行前に契約条件の最終確認をしたい。なぜなら実行後の条件変更はお客様に不利益が生じるからだ。",
                },
              ],
            },
          ],
        },
        {
          id: "ln-cancel",
          standalone: true,
          actions: [
            {
              id: "ln-a8",
              actorId: "exam",
              text: "申込の辞退に対応する",
              stories: [],
            },
          ],
        },
      ],
    },
  },
  {
    id: "cx-fraud",
    name: "不正モニタリング",
    map: {
      actors: [
        { id: "comp", name: "コンプライアンス担当" },
        { id: "op", name: "オペレーター" },
        { id: "cust", name: "お客様" },
        { id: "sys", name: "基幹システム" },
      ],
      activities: [
        {
          id: "fr-detect",
          flowName: "検知",
          actions: [
            {
              id: "fr-a1",
              actorId: "sys",
              text: "取引をスコアリングする",
              stories: [
                {
                  id: "fr-s1",
                  text: "基幹システムは、送金実行の前にリスクスコアを算出したい。なぜなら実行後の資金回収はほぼ不可能だからだ。",
                },
              ],
            },
            {
              id: "fr-a2",
              actorId: "comp",
              text: "アラートを確認する",
              stories: [],
            },
          ],
        },
        {
          id: "fr-investigate",
          flowName: "調査・対応",
          actions: [
            {
              id: "fr-a3",
              actorId: "comp",
              text: "取引を調査する",
              stories: [],
            },
          ],
        },
        {
          id: "fr-respond",
          flowName: "調査・対応",
          actions: [
            {
              id: "fr-a4",
              actorId: "comp",
              text: "口座を凍結する",
              fixed: true,
              stories: [
                {
                  id: "fr-s2",
                  text: "コンプライアンス担当は、不正の疑いが強い口座を即時凍結したい。なぜなら被害拡大は分単位で進むからだ。",
                  fixed: true,
                },
              ],
            },
            {
              id: "fr-a5",
              actorId: "op",
              text: "お客様へ連絡する",
              stories: [],
            },
          ],
        },
        {
          id: "fr-unfreeze",
          standalone: true,
          actions: [
            {
              id: "fr-a6",
              actorId: "comp",
              text: "凍結解除を判断する",
              fixed: true,
              stories: [
                {
                  id: "fr-s3",
                  text: "コンプライアンス担当は、凍結解除を役員承認で行いたい。なぜなら誤凍結・誤解除のどちらでも説明責任が問われるからだ。",
                  fixed: true,
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    id: "cx-support",
    name: "カスタマーサポート",
    map: {
      actors: [
        { id: "cust", name: "お客様" },
        { id: "sup", name: "サポート担当" },
        { id: "op", name: "オペレーター" },
      ],
      activities: [
        {
          id: "sp-inquiry",
          flowName: "問い合わせ",
          actions: [
            {
              id: "sp-a1",
              actorId: "cust",
              text: "問い合わせる",
              stories: [
                {
                  id: "sp-s1",
                  text: "お客様は、チャットで待たずに問い合わせたい。なぜなら電話は待ち時間が長いからだ。",
                },
              ],
            },
            {
              id: "sp-a2",
              actorId: "sup",
              text: "一次回答する",
              stories: [],
            },
          ],
        },
        {
          id: "sp-escalate",
          flowName: "問い合わせ",
          actions: [
            {
              id: "sp-a3",
              actorId: "sup",
              text: "担当部署へエスカレーションする",
              stories: [],
            },
          ],
        },
        {
          id: "sp-limit",
          standalone: true,
          actions: [
            {
              id: "sp-a4",
              actorId: "sup",
              text: "限度額変更を受け付ける",
              stories: [
                {
                  id: "sp-s2",
                  text: "サポート担当は、限度額変更を本人確認のうえ即日反映したい。なぜならお客様は急ぎの支払いのために変更を頼んでくるからだ。",
                },
              ],
            },
          ],
        },
        {
          id: "sp-reissue",
          standalone: true,
          actions: [
            {
              id: "sp-a5",
              actorId: "sup",
              text: "カード再発行を受け付ける",
              stories: [],
            },
          ],
        },
      ],
    },
  },
];

// ---- 共有ドメイン知識(_common) ------------------------------------------------

export interface FixtureSource {
  id: string;
  fileName: string;
  enabled: boolean;
  entries: { category: KnowledgeCategory; title: string; content: string }[];
}

export const SOURCES: FixtureSource[] = [
  {
    id: "cx-src-terms",
    fileName: "全社用語集.md",
    enabled: true,
    entries: [
      { category: "terms", title: "eKYC", content: "オンラインで完結する本人確認。犯収法に基づく手法(ホ)を採用し、当日中の口座開設を可能にする。" },
      { category: "terms", title: "BSAD", content: "基本設計書の社内略称。" },
      { category: "terms", title: "SWIFT", content: "国際銀行間通信協会。外国送金の電文(MT103 等)の送受信に使う。" },
      { category: "terms", title: "コルレス銀行", content: "外国送金の中継・決済を担う提携銀行。コルレス契約に基づく。" },
      { category: "terms", title: "カットオフ", content: "当日扱いの受付締め時刻。以降の依頼は翌営業日扱いになる。" },
      { category: "terms", title: "手数料区分(SHA / OUR / BEN)", content: "外国送金の手数料負担区分。SHA: 双方負担 / OUR: 送金人負担 / BEN: 受取人負担。" },
      { category: "terms", title: "制裁リスト", content: "OFAC・財務省等が公表する経済制裁対象者の一覧。外国送金は全件照合する。" },
      { category: "terms", title: "反社チェック", content: "反社会的勢力データベースとの照合。口座開設・ローン審査で必須。" },
      { category: "terms", title: "被仕向送金", content: "海外から当行のお客様宛に届く送金。仕向送金(当行から海外へ)の対義語。" },
      { category: "terms", title: "組み戻し", content: "実行済み送金の返金依頼。受取人の同意が必要で、手数料が発生する。" },
    ],
  },
  {
    id: "cx-src-actors",
    fileName: "組織と役割.md",
    enabled: true,
    entries: [
      { category: "actors", title: "オペレーター", content: "送金・口座開設の事務処理と一次チェックを担う。差し戻し・組み戻しの窓口。" },
      { category: "actors", title: "コンプライアンス担当", content: "制裁リスト照合、不正モニタリング、口座凍結の判断を担う。" },
      { category: "actors", title: "為替ディーラー", content: "外国送金の適用レートの確定を担当する。" },
      { category: "actors", title: "審査担当", content: "口座開設・ローンの審査(反社チェック・信用情報・担保評価)を担う。" },
      { category: "actors", title: "決裁権限", content: "部長: 1,000万円超の国内送金・融資実行の承認。役員: 2億円超の送金・口座凍結の解除の承認。" },
      { category: "actors", title: "保証会社", content: "住宅ローンの保証を引き受けるグループ会社。本審査で保証承諾を出す。" },
    ],
  },
  {
    id: "cx-src-rules",
    fileName: "送金業務規程.md",
    enabled: true,
    entries: [
      { category: "flows", title: "国内送金の承認ルール", content: "1,000万円を超える国内送金は部長承認、2億円を超える場合は役員承認が必要。" },
      { category: "flows", title: "カットオフ時刻", content: "国内送金・外国送金ともカットオフは 15:00。以降の受付は翌営業日扱い。" },
      { category: "flows", title: "制裁リスト照合", content: "外国送金は送金人・受取人・受取銀行を制裁リストと全件照合する。ヒット時はコンプライアンス承認が完了するまで実行しない。" },
      { category: "flows", title: "差し戻しルール", content: "形式不備は受付当日中に依頼元へ差し戻す。理由コードを必ず付す。" },
      { category: "flows", title: "休日の取り扱い", content: "土日祝の受付は翌営業日扱い。予約送金は前営業日の 15:00 までに残高を確保する。" },
      { category: "flows", title: "限度額変更", content: "送金限度額の変更は本人確認のうえ即日反映する。引き上げ幅が 1 日 1,000万円を超える場合は翌日反映。" },
      { category: "flows", title: "組み戻し手続き", content: "組み戻しは受取人の同意を得てから資金を返却する。手数料は 880 円。" },
      { category: "flows", title: "凍結口座の送金", content: "顧客ステータスが凍結(02)の口座からの送金依頼は自動で謝絶する。" },
    ],
  },
  {
    id: "cx-src-if",
    fileName: "勘定系IF定義.md",
    enabled: true,
    entries: [
      { category: "data", title: "送金種別", content: "送金種別の値域: 01:即時 / 02:予約 の 2 種類。" },
      { category: "data", title: "送金指示番号", content: "英数字 12 桁で採番する。先頭 2 桁はチャネルコード。" },
      { category: "data", title: "送金金額の上限", content: "国内送金は 1 回 1 億円まで。外国送金は 1 回 50万 USD 相当まで。" },
      { category: "data", title: "通貨コード", content: "ISO 4217 の 3 文字コード(JPY / USD / EUR など)を使用する。" },
      { category: "data", title: "顧客ステータスコード", content: "01: 通常 / 02: 凍結 / 03: 解約。凍結は不正モニタリングまたは本人申告による。" },
      { category: "data", title: "eKYC 結果コード", content: "OK: 承認 / NG: 否決 / RE: 再撮影依頼。RE は 3 回まで。" },
      { category: "data", title: "手数料区分コード", content: "外国送金の手数料区分は SHA / OUR / BEN のいずれかを必須入力。" },
    ],
  },
  {
    id: "cx-src-hearing",
    fileName: "顧客ヒアリングメモ.md",
    enabled: true,
    entries: [
      { category: "background", title: "月末の処理滞留", content: "月末は送金処理が滞留し、手作業チェックの負荷が高い。締め日の 25 日は通常の 3 倍の件数。" },
      { category: "background", title: "eKYC の離脱率", content: "eKYC の撮影ステップで約 3 割が離脱している。撮影のやり直し(RE)が主因。" },
      { category: "background", title: "不正振込被害の増加", content: "フィッシング起点の不正振込被害が前年比 2 倍。検知から凍結までの時間短縮が課題。" },
      { category: "background", title: "ローン審査の期間", content: "本審査に 2 週間かかることへの不満が多い。書類の不備往復が主因。" },
      { category: "background", title: "サポートの待ち時間", content: "電話サポートの平均待ち時間 8 分。限度額変更とカード再発行が問い合わせの半数を占める。" },
    ],
  },
  {
    id: "cx-src-old-rules",
    fileName: "旧送金規程(2019年版).md",
    enabled: false, // off の資料: この事実が見えたら漏れ
    entries: [
      { category: "flows", title: "国内送金の承認ルール(旧)", content: "500万円を超える国内送金は部長承認が必要。" },
      { category: "flows", title: "カットオフ時刻(旧)", content: "カットオフは 14:00。" },
    ],
  },
];

// ---- シード ------------------------------------------------------------------

/** 資料の「原文」(出典ビューア・再抽出用)をエントリから合成する */
function originalOf(src: FixtureSource): string {
  return [
    `# ${src.fileName.replace(/\.md$/, "")}`,
    ...src.entries.map((e) => `## ${e.title}\n\n${e.content}`),
  ].join("\n\n");
}

/**
 * フィクスチャ一式を現在の DATA_DIR へシードする(冪等)。
 * cx- プレフィクスのボード・資料・エントリだけを入れ替え、既存データは残す。
 */
export async function seedComplexBank(): Promise<void> {
  // ボード一覧(マージ)
  const boardsPath = path.join(dataRoot(), "boards.json");
  let boards: BoardMeta[] = [];
  try {
    boards = JSON.parse(await fs.readFile(boardsPath, "utf-8")) as BoardMeta[];
  } catch {
    /* 初回 */
  }
  boards = boards.filter((b) => !b.id.startsWith("cx-"));
  boards.push(
    ...BOARDS.map(({ id, name }) => ({ id, name, createdAt: SEEDED_AT })),
  );
  await fs.mkdir(dataRoot(), { recursive: true });
  await fs.writeFile(boardsPath, JSON.stringify(boards, null, 2), "utf-8");

  // マップ(保存経路を通すことで正規化 + 確定断片キャッシュも更新される)
  for (const b of BOARDS) {
    await saveStoryMap(b.id, b.map, "edit", "複雑システムフィクスチャのシード");
  }

  // 共有知識(_common へマージ)
  const sources = (await readSources(COMMON_SCOPE)).filter(
    (s) => !s.id.startsWith("cx-src-"),
  );
  const entries = (await readEntries(COMMON_SCOPE)).filter(
    (e) => !e.id.startsWith("cx-ent-"),
  );
  for (const src of SOURCES) {
    sources.push({
      id: src.id,
      fileName: src.fileName,
      enabled: src.enabled,
      entryCount: src.entries.length,
      uploadedAt: SEEDED_AT,
    });
    src.entries.forEach((e, i) =>
      entries.push({
        id: `cx-ent-${src.id}-${i}`,
        sourceId: src.id,
        common: true,
        ...e,
      }),
    );
    await saveOriginal(
      COMMON_SCOPE,
      src.id,
      src.fileName,
      Buffer.from(originalOf(src), "utf-8"),
    );
  }
  await writeJson(sourcesFile(COMMON_SCOPE), sources);
  await writeJson(knowledgeFile(COMMON_SCOPE), entries);
}
