"use client";

import { useState } from "react";
import Card from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Alert from "@/components/ui/Alert";
import { generateStyleProfileAction } from "@/app/dashboard/blog/settings/style-profile/actions";
import { formatDateJST } from "@/lib/blog/date";
import { MIN_STYLE_PROFILE_POSTS } from "@/lib/blog/config/hotpepper";
import type { SalonStyleProfile } from "@/lib/blog/types";

interface Props {
  selectedCount: number;
  profile: SalonStyleProfile | null;
}

const PROFILE_FIELD_LABELS: { key: keyof SalonStyleProfile["profile"]; label: string }[] = [
  { key: "tone", label: "文章のトーン" },
  { key: "sentenceLength", label: "一文の長さ" },
  { key: "politeness", label: "敬語レベル" },
  { key: "emojiLevel", label: "絵文字の使用量" },
  { key: "lineBreakStyle", label: "改行の入れ方" },
  { key: "endingStyle", label: "締め方の傾向" },
  { key: "compositionPattern", label: "記事の構成パターン" },
];

export default function StyleProfilePanel({ selectedCount, profile }: Props) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canGenerate = selectedCount >= MIN_STYLE_PROFILE_POSTS;

  async function handleGenerate() {
    if (generating || !canGenerate) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateStyleProfileAction();
      if (!result.ok) {
        setError(result.error ?? "文体プロファイルの生成に失敗しました。");
      }
    } catch (err) {
      console.error(err);
      setError("文体プロファイルの生成に失敗しました。もう一度お試しください。");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="font-medium text-ink">Style Profile（文体プロファイル）</p>
        <p className="mt-1 text-sm text-ink-muted">
          選択中の記事: {selectedCount}件
          {!canGenerate && `（作成には${MIN_STYLE_PROFILE_POSTS}件以上の選択が必要です）`}
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <Button
        type="button"
        onClick={handleGenerate}
        disabled={!canGenerate || generating}
        fullWidth
        className="sm:w-auto sm:px-6"
      >
        {generating ? "分析しています…" : profile ? "文体プロファイルを作り直す" : "文体プロファイルを作成する"}
      </Button>

      {profile && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs text-ink-muted">
            {formatDateJST(profile.generatedAt ?? profile.updatedAt)} 作成（{profile.sourcePostIds.length}件の記事を分析）
          </p>
          <dl className="flex flex-col gap-1.5 text-sm">
            {PROFILE_FIELD_LABELS.map(({ key, label }) => (
              <div key={key} className="flex gap-2">
                <dt className="w-24 shrink-0 text-ink-muted">{label}</dt>
                <dd className="text-ink">{profile.profile[key] as string}</dd>
              </div>
            ))}
          </dl>
          {profile.profile.commonExpressions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.profile.commonExpressions.map((expr) => (
                <Badge key={expr} variant="neutral">
                  {expr}
                </Badge>
              ))}
            </div>
          )}

          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-muted">小見出し</dt>
              <dd className="text-ink">
                {profile.profile.headingStyle.usesHeadings
                  ? `使う（${profile.profile.headingStyle.usage}）`
                  : "使わない"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-muted">箇条書き</dt>
              <dd className="text-ink">
                {profile.profile.listStyle.usesBulletLists ? "使う" : "使わない"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-muted">番号付きリスト</dt>
              <dd className="text-ink">
                {profile.profile.listStyle.usesNumberedLists ? "使う" : "使わない"}
              </dd>
            </div>
          </dl>

          {profile.profile.headingStyle.usesHeadings &&
            profile.profile.headingStyle.preferredSymbols.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {profile.profile.headingStyle.preferredSymbols.map((symbol) => (
                  <Badge key={symbol} variant="neutral">
                    {symbol}
                  </Badge>
                ))}
              </div>
            )}

          {profile.profile.listStyle.usesBulletLists && (
            <div className="flex flex-wrap gap-1.5">
              {profile.profile.listStyle.preferredBullets.map((bullet) => (
                <Badge key={bullet} variant="neutral">
                  {bullet}
                </Badge>
              ))}
              {profile.profile.listStyle.commonUseCases.map((useCase) => (
                <Badge key={useCase} variant="neutral">
                  {useCase}
                </Badge>
              ))}
            </div>
          )}

          <dl className="flex flex-col gap-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-muted">絵文字</dt>
              <dd className="text-ink">{profile.profile.emojiStyle.level}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-muted">顔文字</dt>
              <dd className="text-ink">
                {profile.profile.kaomojiStyle.usesKaomoji ? "使う" : "使わない"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-ink-muted">装飾記号</dt>
              <dd className="text-ink">
                {profile.profile.decorativeSymbolStyle.usesSymbols ? "使う" : "使わない"}
              </dd>
            </div>
          </dl>

          {profile.profile.emojiStyle.preferred.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.profile.emojiStyle.preferred.map((symbol) => (
                <Badge key={symbol} variant="neutral">
                  {symbol}
                </Badge>
              ))}
            </div>
          )}

          {profile.profile.kaomojiStyle.usesKaomoji && (
            <div className="flex flex-wrap gap-1.5">
              {profile.profile.kaomojiStyle.preferred.map((symbol) => (
                <Badge key={symbol} variant="neutral">
                  {symbol}
                </Badge>
              ))}
            </div>
          )}

          {profile.profile.decorativeSymbolStyle.usesSymbols && (
            <div className="flex flex-wrap gap-1.5">
              {profile.profile.decorativeSymbolStyle.preferred.map((symbol) => (
                <Badge key={symbol} variant="neutral">
                  {symbol}
                </Badge>
              ))}
            </div>
          )}

          {profile.profile.punctuationStyle.commonSentenceEndings.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.profile.punctuationStyle.commonSentenceEndings.map((symbol) => (
                <Badge key={symbol} variant="neutral">
                  {symbol}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
