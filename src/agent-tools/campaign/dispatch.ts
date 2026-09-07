import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { resolveLane } from "../../agent-core/subagents/lanes";
import { resolveSubagentToolScope } from "../../agent-core/subagents/scope";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { assertCampaignAsset, campaignIdFor, loadCampaign } from "./shared";

type DispatchTask = { title: string; prompt: string; lane?: string; assetIds?: string[]; claim?: string };

export const campaignDispatchTool: ToolDefinition = {
  name: "campaign_dispatch",
  description: "Dispatch one or more campaign subagents with explicit, non-overlapping ownership claims and optional specialist lanes. Workers may return evidence and candidate hypotheses but never confirmed findings; use background=true only when the parent has independent work to continue.",
  inputSchema: { type: "object", required: ["tasks"], properties: { campaignId: { type: "string" }, background: { type: "boolean" }, tasks: { type: "array", minItems: 1, items: { type: "object", required: ["title", "prompt"], properties: { title: { type: "string" }, prompt: { type: "string" }, lane: { type: "string" }, claim: { type: "string", description: "exclusive source, asset, hypothesis, or workflow slice owned by this worker; required when dispatching multiple workers" }, assetIds: { type: "array", items: { type: "string" } } } } } } },
  mutates: true,
  timeoutMs: Number.POSITIVE_INFINITY,
  parallel: false,
  concurrencyScope: "session",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const campaignId = campaignIdFor(context, args);
    const campaign = loadCampaign(context, campaignId);
    if (!context.delegateSession) throw new Error("delegation is unavailable in this runtime");
    if (!Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error("tasks must contain at least one worker task");
    const background = args.background === true;
    const tasks = args.tasks.map((task) => {
      if (!task || typeof task !== "object") throw new Error("each task must be an object");
      const item = task as Record<string, unknown>;
      return {
        title: asString(item.title, "task.title").trim(),
        prompt: asString(item.prompt, "task.prompt").trim(),
        ...(typeof item.lane === "string" ? { lane: item.lane } : {}),
        ...(typeof item.claim === "string" && item.claim.trim() ? { claim: item.claim.trim() } : {}),
        ...(Array.isArray(item.assetIds) ? { assetIds: item.assetIds.map(String) } : {})
      } satisfies DispatchTask;
    });
    if (tasks.some((task) => !task.title || !task.prompt)) throw new Error("task title and prompt must be non-empty");
    if (tasks.length > 1 && tasks.some((task) => !task.claim)) throw new Error("each parallel campaign worker requires an exclusive claim");
    const claims = tasks.flatMap((task) => task.claim ? [normalizeClaim(task.claim)] : []);
    if (new Set(claims).size !== claims.length) throw new Error("parallel campaign worker claims must be unique");
    if (context.availableTools) {
      const availableTools = context.availableTools();
      for (const task of tasks) {
        const lane = task.lane ? resolveLane(context.rootWorkspace ?? context.workspace, task.lane) : undefined;
        if (task.lane && !lane) throw new Error(`unknown subagent lane: ${task.lane}`);
        resolveSubagentToolScope({
          parent: context.session,
          availableTools,
          ...(lane?.tools ? { requestedTools: lane.tools } : {})
        });
      }
    }
    const activeRun = context.campaignControl?.active();
    if (activeRun && activeRun.campaignId !== campaignId) throw new Error("dispatch campaign does not match the active campaign run");
    for (const task of tasks) for (const assetId of task.assetIds ?? []) assertCampaignAsset(context, campaignId, assetId);
    const wave = activeRun
      ? context.store.listCampaignWaves?.(activeRun.id).find((item) => item.id === activeRun.currentWaveId)
      : undefined;
    if (activeRun && !wave) throw new Error("active campaign run has no leased wave");
    const owner = context.campaignControl?.owner ?? context.toolCallId ?? context.session.id;
    const results = await Promise.all(tasks.map(async (task) => {
      const claim = activeRun && wave && context.store.createCampaignClaim && context.store.leaseCampaignClaim
        ? context.store.createCampaignClaim({ runId: activeRun.id, waveId: wave.id, claimKey: normalizeClaim(task.claim ?? task.title), title: task.title, status: "available" })
        : undefined;
      const leasedClaim = claim && context.store.leaseCampaignClaim ? context.store.leaseCampaignClaim(claim.id, owner, 60_000) : undefined;
      if (claim && !leasedClaim) throw new Error(`campaign claim is already owned: ${claim.claimKey}`);
      const contract = [
        `Campaign: ${campaign.name} (${campaign.kind})`,
        `Lane: ${task.lane ?? "unspecified"}`,
        `Exclusive claim: ${task.claim ?? "the entire single-worker task"}`,
        task.assetIds?.length ? `Assets: ${task.assetIds.join(", ")}` : "Assets: choose only from campaign dossier",
        "Worker contract: stay inside the exclusive claim; do not duplicate sibling work; save observations/evidence; create candidate hypotheses; never mark findings verified; return concise structured next steps.",
        `Task: ${task.prompt}`
      ].join("\n");
      try {
        const result = await context.delegateSession!({ title: `worker: ${task.title}`, prompt: contract, ...(task.lane ? { lane: task.lane } : {}), mode: background ? "detached" : "attached", linkToolCall: false, ...(activeRun ? { campaignRunId: activeRun.id } : {}), ...(leasedClaim ? { campaignClaimId: leasedClaim.id, campaignClaimOwner: owner } : {}) });
        if (leasedClaim && !background) {
          if (context.store.settleCampaignClaim) context.store.settleCampaignClaim(leasedClaim.id, owner, "completed", result.sessionId);
          else if (context.store.updateCampaignClaim) context.store.updateCampaignClaim(leasedClaim.id, { status: "completed", sessionId: result.sessionId, leaseOwner: null, leaseExpiresAt: null });
        }
        return { task, result, ...(leasedClaim ? { claimId: leasedClaim.id } : {}) };
      } catch (error) {
        if (leasedClaim) {
          if (context.store.settleCampaignClaim) context.store.settleCampaignClaim(leasedClaim.id, owner, "failed");
          else if (context.store.updateCampaignClaim) context.store.updateCampaignClaim(leasedClaim.id, { status: "failed", leaseOwner: null, leaseExpiresAt: null });
        }
        throw error;
      }
    }));
    return {
      ok: true,
      summary: background ? `dispatched ${results.length} background campaign worker(s)` : `dispatched ${results.length} campaign worker(s)`,
      output: JSON.stringify(results, null, 2),
      metadata: { campaignId, workerCount: results.length, background }
    };
  }
};

function normalizeClaim(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
