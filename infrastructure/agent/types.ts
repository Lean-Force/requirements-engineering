// LLM ゲートウェイの入出力型。
import type { KnowledgeCategory } from "@/contracts";

/** 資料から抽出されたドメイン知識 1 件(保存前の形) */
export interface ExtractedEntry {
  category: KnowledgeCategory;
  title: string;
  content: string;
  /** true = 業務横断の共通知識(抽出時に AI が判定) */
  common: boolean;
}

/** 矛盾検出の 1 件(保存前の形) */
export interface DetectedConflict {
  topic: string;
  newClaim: string;
  existingSource: string;
  existingClaim: string;
}

/** 新しい業務の検知結果 */
export interface DetectedBusiness {
  /** 既存のどの業務でもない、新しい業務の資料か */
  isNewBusiness: boolean;
  /** 業務名の候補(isNewBusiness = false のときは空文字) */
  name: string;
  /** 判定理由(1〜2文) */
  reason: string;
}
