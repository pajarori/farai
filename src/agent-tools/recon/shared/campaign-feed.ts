import type { CampaignAsset, CampaignFeed, CampaignObservation } from "../../../types";

export type { CampaignFeedAsset as FeedAsset, CampaignFeedObservation as FeedObservation } from "../../../types";

export type CampaignFeedStore = {
  upsertAsset: (asset: Omit<CampaignAsset, "id" | "firstSeen" | "lastSeen">) => CampaignAsset;
  listAssets: (campaignId: string) => CampaignAsset[];
  addObservation: (observation: Omit<CampaignObservation, "id" | "createdAt" | "updatedAt">) => CampaignObservation;
  listObservations: (campaignId: string, assetId?: string) => CampaignObservation[];
};

export function feedCampaign(store: CampaignFeedStore, campaignId: string, feed: CampaignFeed): void {
  const existing = store.listAssets(campaignId);
  const byCanonical = new Map<string, CampaignAsset>(existing.map((asset) => [asset.canonical, asset]));
  const idByCanonical = new Map<string, string>(existing.map((asset) => [asset.canonical, asset.id]));
  const assets = [...(feed.assets ?? [])].sort((left, right) => Number(Boolean(left.parentCanonical)) - Number(Boolean(right.parentCanonical)));
  for (const asset of assets) {
    const prior = byCanonical.get(asset.canonical);
    const parentId = asset.parentCanonical ? idByCanonical.get(asset.parentCanonical) : prior?.parentId;
    const technologies = [...new Set([...(prior?.technologies ?? []), ...(asset.technologies ?? [])])];
    const metadata = { ...(prior?.metadata ?? {}), ...(asset.metadata ?? {}) };
    const saved = store.upsertAsset({
      campaignId,
      canonical: asset.canonical,
      kind: asset.kind,
      ...(parentId ? { parentId } : {}),
      technologies,
      metadata,
      confidence: asset.confidence ?? prior?.confidence ?? 0.5
    });
    byCanonical.set(saved.canonical, saved);
    idByCanonical.set(saved.canonical, saved.id);
  }
  if (!feed.observations?.length) return;
  const seen = new Set(store.listObservations(campaignId).map((item) => `${item.assetId ?? ""}:${item.kind}:${item.source}`));
  for (const observation of feed.observations) {
    const assetId = observation.assetCanonical ? idByCanonical.get(observation.assetCanonical) : undefined;
    const key = `${assetId ?? ""}:${observation.kind}:${observation.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.addObservation({
      campaignId,
      ...(assetId ? { assetId } : {}),
      kind: observation.kind,
      value: observation.value,
      confidence: observation.confidence ?? 0.5,
      source: observation.source,
      evidenceIds: [],
      status: "active"
    });
  }
}
