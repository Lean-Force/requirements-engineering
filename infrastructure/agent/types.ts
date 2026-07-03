// LLM ゲートウェイの入出力型(index.ts と fake.ts が共有する)。
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
