import type { FeedObservation } from "./campaign-feed";

export function urlInventoryObservations(urls: string[], source: string): FeedObservation[] {
  const byHost = new Map<string, string[]>();
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host) continue;
    const bucket = byHost.get(host) ?? [];
    if (bucket.length < 10) bucket.push(url);
    byHost.set(host, bucket);
  }
  const counts = new Map<string, number>();
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
    } catch {
      continue;
    }
  }
  return [...byHost.entries()].map(([host, sample]) => ({
    assetCanonical: host,
    kind: "url_inventory",
    value: { count: counts.get(host) ?? sample.length, sample },
    source,
    confidence: 0.7
  }));
}
