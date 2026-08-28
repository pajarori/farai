export type DialogOption<TValue = unknown> = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  footer?: string;
  disabled?: boolean;
  value: TValue;
};

export type FuzzyMatch<TValue> = {
  option: DialogOption<TValue>;
  score: number;
};

const TITLE_WEIGHT = 2;

export function filterOptions<TValue>(
  options: readonly DialogOption<TValue>[],
  needle: string
): FuzzyMatch<TValue>[] {
  const query = needle.trim().toLowerCase();
  if (!query) {
    return options.map((option) => ({ option, score: 0 }));
  }
  return options
    .map((option, order) => ({ option, score: matchScore(option, query), order }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 200)
    .map(({ option, score }) => ({ option, score }));
}

export function groupByCategory<TValue>(
  matches: readonly FuzzyMatch<TValue>[],
  needleActive: boolean
): Array<{ category: string | undefined; matches: FuzzyMatch<TValue>[] }> {
  if (needleActive) return [{ category: undefined, matches: [...matches] }];
  const buckets = new Map<string | undefined, FuzzyMatch<TValue>[]>();
  for (const match of matches) {
    const key = match.option.category;
    const list = buckets.get(key) ?? [];
    list.push(match);
    buckets.set(key, list);
  }
  return [...buckets.entries()].map(([category, list]) => ({ category, matches: list }));
}

function matchScore<TValue>(option: DialogOption<TValue>, query: string): number {
  const title = option.title.toLowerCase();
  const category = option.category?.toLowerCase() ?? "";
  const description = option.description?.toLowerCase() ?? "";
  if (title === query) return 10_000;
  if (title.startsWith(query)) return 8_000 - title.length;
  if (category === query) return 4_000;
  if (category.startsWith(query)) return 3_000 - category.length;
  if (title.includes(query)) return 2_000 - title.indexOf(query);
  if (description.includes(query)) return 1_000 - description.indexOf(query);
  return 0;
}
