import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DOCKER_ROUTING_ENV = [
  "DOCKER_API_VERSION",
  "DOCKER_CERT_PATH",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY"
] as const;

export function faraiDockerEnvironment(
  input: NodeJS.ProcessEnv = process.env,
  localHost: string | undefined = detectLocalDockerHost(input)
): Record<string, string> {
  const env = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  for (const key of DOCKER_ROUTING_ENV) delete env[key];
  if (localHost) env.DOCKER_HOST = localHost;
  return env;
}

export function detectLocalDockerHost(input: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform === "win32") return undefined;
  const home = input.HOME?.trim() || homedir();
  const runtime = input.XDG_RUNTIME_DIR?.trim();
  const candidates = [
    ...(process.platform === "darwin" ? [join(home, ".docker", "run", "docker.sock")] : []),
    "/var/run/docker.sock",
    ...(runtime ? [join(runtime, "docker.sock")] : []),
    join(home, ".colima", "default", "docker.sock"),
    join(home, ".orbstack", "run", "docker.sock")
  ];
  for (const path of candidates) {
    try {
      if (statSync(path).isSocket()) return `unix://${path}`;
    } catch {}
  }
  return undefined;
}
