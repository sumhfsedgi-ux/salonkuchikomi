import { describe, expect, it } from "vitest";
import { assessIntent, reviewCharacterCount } from "@/lib/ai/naturalJapanese/evidence";
import { lintDraft } from "@/lib/ai/naturalJapanese/lint";
import { buildMaterials, toLintSources, type MaterialInput } from "@/lib/reviewGeneration/materials";
import { buildStyleSeed } from "@/lib/reviewGeneration/plan";
import { lengthGuidance } from "@/lib/reviewGeneration/length";
import { missingEvidence } from "@/lib/reviewGeneration/coverage";
import { buildGenerationUserPrompt, buildVerificationUserPrompt } from "@/lib/reviewGeneration/prompts";
import { buildAppealPlan } from "@/lib/reviewGeneration/appeal";
import { runReviewPipeline } from "@/lib/reviewGeneration/pipeline";
import type { CallJson } from "@/lib/reviewGeneration/verify";

const input = (questionText: string, ...selected: string[]): MaterialInput => ({questionText,selected,questionType:"multiple"});
const inputs = [input("ご来店は何回目ですか？","初めて"),input("ご来店のきっかけは？","Instagramを見て"),input("利用したメニュー","眉毛パーマ"),input("スタッフの対応はいかがでしたか？","カウンセリングが丁寧だった"),input("仕上がりはどうでしたか？","理想通りの仕上がりだった"),input("店内の印象は？","清潔感があって安心できた"),input("今後のご利用は？","ぜひまた来たい")];

describe("口コミの自然な言い換えと意味の保持", () => {
  it.each(["また伺いたいです。", "またお願いしたいです！", "また来たいと思えるお店です。"])("再来店意向の同義表現を残す: %s", text => {
    const m = buildMaterials([input("今後について教えてください", "ぜひまた来たい")]);
    expect(lintDraft([{text,sourceIds:["M1"]}],toLintSources(m)).issues).toEqual([]);
  });
  it("来店経路の同義表記を誤って捏造扱いしない", () => {
    const m = buildMaterials([input("来店のきっかけ", "Instagramを見て")]);
    expect(lintDraft([{text:"インスタを見て伺いました。",sourceIds:["M1"]}],toLintSources(m)).issues).toEqual([]);
  });
  it.each([
    ["また来たい", "おすすめしたいです", "unsupported"],
    ["別のメニューも試したい", "また通いたいです", "unsupported"],
    ["機会があればまた来たい", "また伺いたいです", "risk"],
    ["また来たくない", "また伺いたいです", "risk"],
    ["また来たい", "必ず定期的にまた伺います", "risk"],
    ["まだ分からない", "また伺いたいです", "unsupported"],
  ])("意向の種類・条件・否定を区別する %s → %s", (source,text,result) => {
    expect(assessIntent(text,[source])).toBe(result);
  });
  it("将来の商品調査を利用体験から除き、質問と回答を生成・検証の両方に渡す", () => {
    const materials = buildMaterials([...inputs,input("新メニュー調査です。食べたい商品は？","餃子丼")]);
    expect(materials).toHaveLength(7);
    const prompts = [buildGenerationUserPrompt(materials,buildAppealPlan(materials),buildStyleSeed(materials),"眉毛サロン"),buildVerificationUserPrompt(materials,[])];
    for (const prompt of prompts) {
      expect(prompt).toContain('質問="仕上がりはどうでしたか？"');
      expect(prompt).not.toContain("餃子丼");
    }
    expect(materials[1].role).toBe("discovery");
  });
  it("改善希望と否定的な再来店意向を必須の内容として残す", () => {
    const m = buildMaterials([input("仕上がりは？","改善してほしい点があった"),input("今後について","利用する予定はない")]);
    expect(m.every(x=>x.negative)).toBe(true);
  });
  it("十分な回答がある場合は、短文や締めなしを偶然選ばない", () => {
    const m = buildMaterials(inputs);
    for (let i=0;i<100;i++) {
      const seed = buildStyleSeed(m,{random:()=>i/100});
      expect(seed.length).not.toBe("short");
      expect(seed.closing).toBe("short_intention_allowed");
    }
    expect(lengthGuidance(m)).toContain("180〜260");
    expect(lengthGuidance(m.slice(0,1))).toContain("80〜170");
  });
  it("出典IDを付けるだけでは仕上がりを反映した扱いにしない", () => {
    const m = buildMaterials([input("仕上がりは？","理想通りの仕上がりだった")]);
    expect(missingEvidence(m,["M1"],[{text:"満足です。",sourceIds:["M1"]}])).toEqual(["M1"]);
    expect(missingEvidence(m,["M1"],[{text:"希望通りの仕上がりでうれしいです。",sourceIds:["M1"]}])).toEqual([]);
  });
  it("句読点、空白、英字は数え、CRLFを数えない",()=>{
    expect(reviewCharacterCount("A B。\r\n眉毛\n！")).toBe(7);
  });
  it("カットというメニュー名だけから接客や満足を追加したら表示しない",()=>{
    const m=buildMaterials([input("利用したメニュー","カット")]);
    const issues=lintDraft([{text:"丁寧に対応してもらえて満足しています！",sourceIds:["M1"]}],toLintSources(m)).issues;
    expect(issues).toContainEqual(expect.objectContaining({code:"factual_invention",severity:"block"}));
  });
  it("初来店だけでは施術が初体験だとは言えず、清潔感だけでリラックスしたと補わない",()=>{
    const m=buildMaterials(inputs);
    for(const text of ["初めて眉毛パーマを受けました。","店内でリラックスできました。"]) {
      const issues=lintDraft([{text,sourceIds:m.map(x=>x.id)}],toLintSources(m)).issues;
      expect(issues).toContainEqual(expect.objectContaining({code:"factual_invention",severity:"risk"}));
    }
  });
  it("質問の『店内』は観点の根拠になるが、質問に含まれる未選択の評価は根拠にしない",()=>{
    const m=buildMaterials([input("店内は清潔でリラックスできましたか？","清潔感があって安心できた")]);
    expect(lintDraft([{text:"店内は清潔感があり安心できました。",sourceIds:["M1"]}],toLintSources(m)).issues).toEqual([]);
    expect(lintDraft([{text:"店内はリラックスできました。",sourceIds:["M1"]}],toLintSources(m)).issues).toContainEqual(expect.objectContaining({code:"factual_invention",severity:"risk"}));
  });
  it("削除で失った良さは回答から修正し、未確認の効果表現を戻さない", async () => {
    const m = buildMaterials([input("仕上がりは？","理想通りの仕上がりだった"),input("今後について","ぜひまた来たい")]);
    const calls: string[] = [];
    const callJson: CallJson = async <T>(options: Parameters<CallJson>[0]) => {
      calls.push(options.task);
      let data: unknown;
      if(options.task === "review_generation") data={sentences:[{text:"人生が変わる仕上がりでした。",source_ids:["M1"],break_after:false},{text:"また伺いたいです！",source_ids:["M2"],break_after:false}]};
      else if(options.task === "review_repair") {
        expect(options.userPrompt).toContain("【失われた重要な回答】M1");
        data={sentences:[{text:"理想通りの仕上がりでうれしいです。",source_ids:["M1"],break_after:true},{text:"また伺いたいです！",source_ids:["M2"],break_after:false}]};
      } else throw new Error("unexpected verification");
      return {data:data as T,model:"mock",usage:null,latencyMs:0,attempts:1};
    };
    const result = await runReviewPipeline({materials:m,businessType:"眉毛"},{callJson,random:()=>0.5});
    expect(result.draft).toContain("理想通りの仕上がり");
    expect(result.draft).not.toContain("人生が変わ");
    expect(result.metadata.appealCovered).toBe(true);
    expect(calls).toEqual(["review_generation","review_repair"]);
  });
});
