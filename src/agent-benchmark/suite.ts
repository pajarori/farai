import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProvider } from "../agent-core/provider/protocol";
import type { PlannerProvider } from "../agent-core/provider";
import { id } from "../utils";
import { atomicWriteFile } from "../agent-core/atomic-file";
import { benchmarkSuiteHash } from "./hash";
import { loadBenchmarkSuiteManifest, normalizeBenchmarkSuiteManifest } from "./manifest";
import { runBenchmark } from "./runner";
import type { BenchmarkCampaignResult, BenchmarkManifest, BenchmarkResult, BenchmarkSuiteManifest } from "./types";

export type BenchmarkSuiteRunOptions = {
  artifactsDir?: string;
  faraiRoot?: string;
  providerFactory?: (manifest: BenchmarkManifest, repetition: number) => PlannerProvider | ChatProvider | Promise<PlannerProvider | ChatProvider>;
};

type RunAttempt = {
  manifest: BenchmarkManifest;
  repetition: number;
};

type RunOutcome =
  | { ok: true; result: BenchmarkResult }
  | { ok: false; manifest: BenchmarkManifest; repetition: number; error: string };

export async function runBenchmarkSuite(input: BenchmarkSuiteManifest, options: BenchmarkSuiteRunOptions = {}): Promise<BenchmarkCampaignResult> {
  const manifest = normalizeBenchmarkSuiteManifest(input);
  const campaignId = id();
  const root = options.artifactsDir ?? mkdtempSync(join(tmpdir(), "farai-benchmark-campaign-"));
  const bundlePath = join(root, `${safeName(manifest.id)}-${campaignId}`);
  const runsPath = join(bundlePath, "runs");
  mkdirSync(runsPath, { recursive: true });
  const attempts: RunAttempt[] = [];
  for (const run of manifest.runs) {
    for (let repetition = 1; repetition <= manifest.repetitions; repetition += 1) attempts.push({ manifest: run, repetition });
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const outcomes = await mapConcurrent(attempts, manifest.concurrency, async (attempt): Promise<RunOutcome> => {
    try {
      const provider = options.providerFactory ? await options.providerFactory(attempt.manifest, attempt.repetition) : undefined;
      const result = await runBenchmark(attempt.manifest, {
        artifactsDir: runsPath,
        repetition: attempt.repetition,
        ...(provider ? { provider } : {}),
        ...(options.faraiRoot ? { faraiRoot: options.faraiRoot } : {})
      });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        manifest: attempt.manifest,
        repetition: attempt.repetition,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  const successful = outcomes.filter((outcome): outcome is Extract<RunOutcome, { ok: true }> => outcome.ok).map((outcome) => outcome.result);
  const byChallenge = new Map<string, number>();
  for (const run of manifest.runs) byChallenge.set(run.challenge.id, 0);
  for (const result of successful) if (result.solved) byChallenge.set(result.challengeId, (byChallenge.get(result.challengeId) ?? 0) + 1);
  const passAtK: Record<string, number> = {};
  for (let k = 1; k <= manifest.repetitions; k += 1) {
    passAtK[`pass@${k}`] = mean([...byChallenge.values()].map((solves) => unbiasedPassAtK(manifest.repetitions, solves, k)));
  }
  const solvedRuns = successful.filter((result) => result.solved).length;
  const result: BenchmarkCampaignResult = {
    campaignId,
    bundlePath,
    suiteId: manifest.id,
    suiteVersion: manifest.version,
    manifestHash: benchmarkSuiteHash(manifest),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    repetitions: manifest.repetitions,
    challengeCount: manifest.runs.length,
    runCount: attempts.length,
    solvedRuns,
    solvedChallenges: [...byChallenge.values()].filter((count) => count > 0).length,
    solveRate: attempts.length ? solvedRuns / attempts.length : 0,
    passAtK,
    totalCost: successful.reduce((total, item) => total + item.usage.totalCost, 0),
    inputTokens: successful.reduce((total, item) => total + item.usage.inputTokens, 0),
    outputTokens: successful.reduce((total, item) => total + item.usage.outputTokens, 0),
    toolCalls: successful.reduce((total, item) => total + item.activity.toolCalls, 0),
    toolErrors: successful.reduce((total, item) => total + item.activity.toolErrors, 0),
    results: outcomes.map((outcome) => outcome.ok ? {
      runId: outcome.result.runId,
      challengeId: outcome.result.challengeId,
      repetition: outcome.result.repetition,
      solved: outcome.result.solved,
      stopReason: outcome.result.stopReason,
      durationMs: outcome.result.durationMs,
      cost: outcome.result.usage.totalCost,
      bundlePath: outcome.result.bundlePath
    } : {
      runId: id(),
      challengeId: outcome.manifest.challenge.id,
      repetition: outcome.repetition,
      solved: false,
      stopReason: "runtime_error",
      durationMs: 0,
      cost: 0,
      bundlePath: "",
      error: outcome.error
    })
  };
  atomicWriteFile(join(bundlePath, "campaign.json"), `${JSON.stringify(result, null, 2)}\n`, 0o600);
  atomicWriteFile(join(bundlePath, "suite.sha256"), `${result.manifestHash}\n`, 0o600);
  return result;
}

export function unbiasedPassAtK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k) || n <= 0 || c < 0 || c > n || k <= 0 || k > n) {
    throw new Error("pass@k requires integers with n > 0, 0 <= c <= n, and 1 <= k <= n");
  }
  if (n - c < k) return 1;
  let miss = 1;
  for (let index = 0; index < k; index += 1) miss *= (n - c - index) / (n - index);
  return 1 - miss;
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, worker: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "suite";
}

export { loadBenchmarkSuiteManifest, normalizeBenchmarkSuiteManifest };
export type { BenchmarkCampaignResult, BenchmarkSuiteManifest } from "./types";
