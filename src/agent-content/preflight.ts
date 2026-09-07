import { createInterface } from "node:readline";
import { loadConfig } from "../agent-core/config";
import { applyContentUpdate, checkContentUpdate, dismissContentVersion, isContentVersionDismissed, type ContentDownloadProgress } from "./updater";

export type StartupPreflightResult = "continue" | "cancelled";

export async function runStartupContentPreflight(workspace: string): Promise<StartupPreflightResult> {
  const status = await checkContentUpdate({ workspace });
  if (status.state !== "update_available" || !status.manifest) return "continue";
  if (isContentVersionDismissed(status.manifest.contentVersion)) return "continue";
  const config = loadConfig(workspace);
  if (config.updates?.prompt === false || !process.stdin.isTTY || !process.stdout.isTTY) return "continue";
  const answer = await promptForUpdate(status.manifest.contentVersion, Boolean(status.manifest.knowledge), Boolean(status.manifest.skills));
  if (answer === "cancelled") return "cancelled";
  if (answer === "dismiss") {
    dismissContentVersion(status.manifest.contentVersion);
    return "continue";
  }
  if (answer === "later") return "continue";
  console.log("updating farai content...");
  try {
    const applied = await applyContentUpdate(status.manifest, status.manifestUrl, { onProgress: renderDownloadProgress() });
    const parts = [applied.knowledge ? "knowledge" : undefined, applied.skills ? "skills" : undefined].filter(Boolean).join(" + ");
    console.log(`updated farai content to ${applied.version}${parts ? ` (${parts})` : ""}`);
  } catch (error) {
    console.error(`content update failed: ${errorMessage(error)}`);
    console.error("starting farai with the current content");
  }
  return "continue";
}

async function promptForUpdate(version: string, knowledge: boolean, skills: boolean): Promise<"apply" | "later" | "dismiss" | "cancelled"> {
  const contents = [knowledge ? "knowledge" : undefined, skills ? "skills" : undefined].filter(Boolean).join(" + ");
  console.log("");
  console.log(`farai content ${version} is available${contents ? ` (${contents})` : ""}`);
  const interfaceHandle = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: "apply" | "later" | "dismiss" | "cancelled") => {
      if (settled) return;
      settled = true;
      interfaceHandle.close();
      resolve(value);
    };
    interfaceHandle.once("SIGINT", () => finish("cancelled"));
    interfaceHandle.question("update before starting? [enter=yes, n=later, d=skip version] ", (value) => {
      const normalized = value.trim().toLowerCase();
      if (normalized === "d" || normalized === "dismiss") finish("dismiss");
      else if (normalized === "n" || normalized === "no") finish("later");
      else finish("apply");
    });
  });
}

function renderDownloadProgress(): ContentDownloadProgress {
  let lastPercent = -1;
  let lastLabel = "";
  return (received, total, label) => {
    if (!process.stdout.isTTY || total <= 0) return;
    if (label !== lastLabel) { lastLabel = label; lastPercent = -1; }
    const percent = Math.min(100, Math.floor((received / total) * 100));
    if (percent === lastPercent && received < total) return;
    lastPercent = percent;
    process.stdout.write(`\r  downloading ${label} ${String(percent).padStart(3)}%  ${megabytes(received)}/${megabytes(total)} MB   `);
    if (received >= total) process.stdout.write("\n");
  };
}

function megabytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
