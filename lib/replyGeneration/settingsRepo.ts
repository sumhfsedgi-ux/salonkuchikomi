import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_REPLY_SETTINGS,
  replySettingsFromRow,
  replySettingsToRow,
  type ReplySettings,
} from "@/lib/replyGeneration/settings";

// 返信設定の読み書き(0013 の review_reply_settings。service role だけが読み書きする)。
// salon_id は必ずサーバーで確定した値(getCurrentSalon の結果)を渡すこと。
// 0013 を適用する前(テーブルが無い)でも画面と返信案の作成が止まらないよう、読み込みは既定値に戻す。

const COLUMNS = "tone, length, include_store_name, revisit_line, signature, contact_note, extra_instructions";

// テーブルが無いときの PostgREST / Postgres のエラーコード。
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);

export interface LoadedReplySettings {
  settings: ReplySettings;
  /** 保存できる状態か(0013 が適用済みで、読み込みにも成功した)。 */
  storageAvailable: boolean;
}

export async function loadReplySettings(admin: SupabaseClient, salonId: string): Promise<LoadedReplySettings> {
  try {
    const { data, error } = await admin
      .from("review_reply_settings")
      .select(COLUMNS)
      .eq("salon_id", salonId)
      .maybeSingle();
    if (error) {
      console.warn("review_reply_settings load failed", { code: error.code });
      // テーブルが無い(0013 の適用前)・そのほかのエラーのどちらでも、保存はできない扱いにする。
      return { settings: { ...DEFAULT_REPLY_SETTINGS }, storageAvailable: false };
    }
    return { settings: replySettingsFromRow(data as Record<string, unknown> | null), storageAvailable: true };
  } catch {
    console.warn("review_reply_settings load failed");
    return { settings: { ...DEFAULT_REPLY_SETTINGS }, storageAvailable: false };
  }
}

export type SaveReplySettingsOutcome = "saved" | "unavailable" | "failed";

export async function saveReplySettings(
  admin: SupabaseClient,
  salonId: string,
  settings: ReplySettings,
): Promise<SaveReplySettingsOutcome> {
  try {
    const { error } = await admin
      .from("review_reply_settings")
      .upsert(replySettingsToRow(salonId, settings), { onConflict: "salon_id" });
    if (!error) return "saved";
    console.warn("review_reply_settings save failed", { code: error.code });
    return MISSING_TABLE_CODES.has(error.code ?? "") ? "unavailable" : "failed";
  } catch {
    console.warn("review_reply_settings save failed");
    return "failed";
  }
}
