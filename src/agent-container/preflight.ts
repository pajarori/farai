import { createInterface } from "node:readline";
import { loadConfig } from "../agent-core/config";
import { faraiDockerEnvironment } from "./docker-environment";
import { DEFAULT_KALI_IMAGE, KaliContainerBackend } from "./kali";

export type StartupPreflightResult = "continue" | "cancelled";

export async function runStartupContainerPreflight(workspace: string): Promise<StartupPreflightResult> {
  const backend = new KaliContainerBackend({ workspace });
  const update = await backend.checkForImageUpdate().catch(() => undefined);
  if (!update || update.error) return "continue";
  if (update.exists && update.upToDate) return "continue";

  const config = loadConfig(workspace);
  if (config.updates?.prompt === false || !process.stdin.isTTY || !process.stdout.isTTY) return "continue";

  const answer = await promptForImagePull(update.exists);
  if (answer === "cancelled") return "cancelled";
  if (answer === "later") return "continue";

  console.log(`pulling ${DEFAULT_KALI_IMAGE}...`);
  const pulled = await spawnPull();
  if (pulled !== 0) {
    console.error("kali image pull failed; farai will retry when the container is first needed");
  }
  return "continue";
}

async function promptForImagePull(exists: boolean): Promise<"apply" | "later" | "cancelled"> {
  console.log("");
  console.log(exists
    ? "a newer kali container image is available"
    : "kali container image is not installed");
  const interfaceHandle = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: "apply" | "later" | "cancelled") => {
      if (settled) return;
      settled = true;
      interfaceHandle.close();
      resolve(value);
    };
    interfaceHandle.once("SIGINT", () => finish("cancelled"));
    interfaceHandle.question("pull before starting? [enter=yes, n=later] ", (value) => {
      const normalized = value.trim().toLowerCase();
      if (normalized === "n" || normalized === "no" || normalized === "later") finish("later");
      else finish("apply");
    });
  });
}

async function spawnPull(): Promise<number> {
  const proc = Bun.spawn(["docker", "pull", DEFAULT_KALI_IMAGE], {
    stdout: "inherit",
    stderr: "inherit",
    env: faraiDockerEnvironment()
  });
  return await proc.exited;
}
