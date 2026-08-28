import type { DialogOption, FuzzyMatch } from "./fuzzy";

export type SelectionDisplayRow<TValue> = {
  option: DialogOption<TValue>;
  matched: boolean;
  disabled: boolean;
  selected: boolean;
};

export function selectableIndex<TValue>(matches: readonly FuzzyMatch<TValue>[], requested: number): number {
  const enabled = matches.filter((match) => !match.option.disabled);
  if (enabled.length === 0) return -1;
  return Math.max(0, Math.min(requested, enabled.length - 1));
}

export function selectedOptionId<TValue>(matches: readonly FuzzyMatch<TValue>[], requested: number): string | undefined {
  const index = selectableIndex(matches, requested);
  return index < 0 ? undefined : matches.filter((match) => !match.option.disabled)[index]?.option.id;
}

export function scrollWindowStart(total: number, cap: number, selectedIndex: number): number {
  if (total <= cap || selectedIndex < 0) return 0;
  if (selectedIndex < cap) return 0;
  return Math.min(selectedIndex - cap + 1, total - cap);
}

export function displayRows<TValue>(matches: readonly FuzzyMatch<TValue>[], selectedId: string | undefined): SelectionDisplayRow<TValue>[] {
  return matches.map((match) => ({
    option: match.option,
    matched: match.score > 0,
    disabled: Boolean(match.option.disabled),
    selected: match.option.id === selectedId
  }));
}
