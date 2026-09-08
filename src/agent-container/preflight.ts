import { createInterface } from "node:readline";
import { FARAI_BANNER } from "../branding";
import { loadConfig } from "../agent-core/config";
import { faraiDockerEnvironment } from "./docker-environment";
import { DEFAULT_KALI_IMAGE, KALI_IMAGE_CONTRACT, KaliContainerBackend } from "./kali";

export type StartupPreflightResult = "continue" | "cancelled";

export async function runStartupContainerPreflight(workspace: string): Promise<StartupPreflightResult> {
  const backend = new KaliContainerBackend({ workspace });
  const image = await backend.resolveImage().catch(() => undefined);
  if (!image || image.error) return "continue";
  if (image.exists && image.contract === KALI_IMAGE_CONTRACT) return "continue";

  const config = loadConfig(workspace);
  if (config.updates?.prompt === false || !process.stdin.isTTY || !process.stdout.isTTY) return "continue";

  const answer = await promptForImagePull(KALI_IMAGE_CONTRACT, image.exists);
  if (answer === "cancelled") return "cancelled";
  if (answer === "later") return "continue";

  console.log(`pulling ${DEFAULT_KALI_IMAGE}...`);
  const pulled = await spawnPull();
  if (pulled !== 0) {
    console.error("kali image pull failed; farai will retry when the container is first needed");
  }
  return "continue";
}

async function promptForImagePull(contract: string, exists: boolean): Promise<"apply" | "later" | "cancelled"> {
  console.log("");
  console.log(FARAI_BANNER);
  console.log("");
  console.log(exists
    ? `kali container image is outdated (needs ${contract})`
    : `kali container image ${contract} is not installed`);
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
