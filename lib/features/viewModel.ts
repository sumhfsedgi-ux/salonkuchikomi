import type { FeatureState } from "@/lib/features/featureState";

export interface FeatureOption {
  key: string;
  label: string;
  description: string;
  selected: boolean;
  comingSoon: boolean;
}

/** 機能の選択フォームに渡す選択肢(契約上使える機能だけ。準備中は選べない形で出す)。 */
export function toFeatureOptions(states: FeatureState[]): FeatureOption[] {
  return states.map((state) => ({
    key: state.key,
    label: state.definition.label,
    description: state.definition.description,
    selected: state.selected,
    comingSoon: !state.available,
  }));
}
