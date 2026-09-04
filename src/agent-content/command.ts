import { existsSync } from "node:fs";
import type { UpdateArguments } from "../cli/command-arguments";
import { legacyKnowledgeDbPath } from "../agent-knowledge/paths";
import type { ContentUpdateStatus } from "./types";
import { applyContentUpdate, checkContentUpdate, contentStatus, rollbackContentUpdate } from "./updater";

export async function runContentUpdateCommand(parsed: UpdateArguments, workspace: string): Promise<number> {
  if (parsed.kind === "status") {
    const status = contentStatus();
    if (!status.active) {
      const knowledge = legacyKnowledgeDbPath();
      console.log("content: not installed");
      console.log("active release: none");
      console.log(`knowledge: ${existsSync(knowledge) ? knowledge : "not installed"}`);
      console.log("skills: not installed");
      return 0;
    }
    console.log(`content: ${status.active.version}`);
    if (status.active.sourceCommit) console.log(`source commit: ${status.active.sourceCommit}`);
    console.log(`activated: ${status.active.activatedAt}`);
    console.log(`knowledge: ${status.knowledgePath ?? "local fallback"}`);
    console.log(`skills: ${status.skillsPath ?? "not installed"}`);
    console.log(`available versions: ${status.versions.join(", ") || "none"}`);
    return 0;
  }
  if (parsed.kind === "rollback") {
    const result = rollbackContentUpdate();
    console.log(`rolled back farai content to ${result.version}`);
    return 0;
  }
  const status = await checkContentUpdate({ workspace, force: true });
  if (parsed.kind === "check") return printContentUpdateStatus(status);
  if (status.state === "up_to_date") {
    console.log(`farai content is up to date${status.active ? ` (${status.active.version})` : ""}`);
    return 0;
  }
  if (status.state !== "update_available" || !status.manifest) return printContentUpdateStatus(status);
  const result = await applyContentUpdate(status.manifest, status.manifestUrl);
  console.log(`updated farai content to ${result.version}`);
  return 0;
}

function printContentUpdateStatus(status: ContentUpdateStatus): number {
  if (status.state === "update_available") {
    console.log(`content update available: ${status.active?.version ?? "none"} -> ${status.manifest?.contentVersion}`);
    if (status.manifest?.sourceCommit) console.log(`source commit: ${status.manifest.sourceCommit}`);
    return 0;
  }
  if (status.state === "up_to_date") {
    console.log(`farai content is up to date${status.active ? ` (${status.active.version})` : ""}`);
    return 0;
  }
  if (status.state === "disabled") {
    console.log("farai content updates are disabled");
    return 0;
  }
  if (status.state === "unavailable") {
    console.log("the content channel has no published artifacts yet");
    return 0;
  }
  if (status.state === "incompatible") {
    console.error(`content ${status.manifest?.contentVersion} requires farai ${status.manifest?.minFaraiVersion} or newer`);
    return 1;
  }
  console.error(`content update check failed: ${status.error ?? "unknown error"}`);
  return 1;
}
