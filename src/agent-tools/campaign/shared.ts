import type { Campaign, CampaignDossier, ToolContext } from "../../types";

export function campaignIdFor(context: ToolContext, args: Record<string, unknown>): string {
  const id = typeof args.campaignId === "string" && args.campaignId.trim() ? args.campaignId.trim() : context.session.campaignId;
  if (!id) throw new Error("campaignId is required; create or attach a campaign first");
  return id;
}

export function loadCampaign(context: ToolContext, campaignId: string): Campaign {
  if (!context.store.loadCampaign) throw new Error("campaign store is unavailable");
  const campaign = context.store.loadCampaign(campaignId);
  if (campaign.workspace !== (context.rootWorkspace ?? context.workspace)) throw new Error("campaign belongs to another workspace");
  return campaign;
}

export function requireCampaignStore<T extends keyof ToolContext["store"]>(context: ToolContext, method: T): NonNullable<ToolContext["store"][T]> {
  const fn = context.store[method];
  if (!fn) throw new Error(`campaign store method ${String(method)} is unavailable`);
  return fn.bind(context.store) as NonNullable<ToolContext["store"][T]>;
}

export function assertCampaignEvidence(context: ToolContext, campaignId: string, evidenceIds: string[]): void {
  if (evidenceIds.length === 0) return;
  if (!context.store.loadEvidence || !context.store.loadSession) {
    const known = new Set(context.store.listEvidence?.(context.session.id).map((item) => item.id) ?? []);
    const unknown = evidenceIds.filter((item) => !known.has(item));
    if (unknown.length > 0) throw new Error(`evidence not found in campaign: ${unknown.join(", ")}`);
    return;
  }
  for (const evidenceId of evidenceIds) {
    const evidence = context.store.loadEvidence(evidenceId);
    const session = context.store.loadSession(evidence.sessionId);
    if (session.campaignId !== campaignId) throw new Error(`evidence belongs to another campaign: ${evidenceId}`);
  }
}

export function assertCampaignAsset(context: ToolContext, campaignId: string, assetId: string | undefined): void {
  if (!assetId) return;
  const asset = requireCampaignStore(context, "listAssets")(campaignId).find((item) => item.id === assetId);
  if (!asset) throw new Error(`asset does not belong to campaign: ${assetId}`);
}

export function compactDossier(dossier: CampaignDossier): string {
  return JSON.stringify({
    campaign: { id: dossier.campaign.id, name: dossier.campaign.name, kind: dossier.campaign.kind, status: dossier.campaign.status },
    assets: dossier.assets.slice(0, 80),
    observations: dossier.observations.slice(0, 80),
    hypotheses: dossier.hypotheses.slice(0, 50),
    findings: dossier.findings.slice(-30),
    searchMatches: dossier.searchMatches
  }, null, 2);
}
