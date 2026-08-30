import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { ToolDefinition } from "../../types";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";

const VPN_NAME_PATTERNS = [/^tun\d*/i, /^utun\d*/i, /^tailscale/i, /^wg\d*/i];
const DOCKER_NAME_PATTERNS = [/^docker/i, /^br-/i, /^veth/i, /^bridge/i];

export type Candidate = { interface: string; address: string; likelyVpn: boolean };

export function rankInterfaces(all: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [name, infos] of Object.entries(all)) {
    if (!infos) continue;
    if (DOCKER_NAME_PATTERNS.some((pattern) => pattern.test(name))) continue;
    for (const info of infos) {
      if (info.internal) continue;
      if (info.family !== "IPv4") continue;
      candidates.push({ interface: name, address: info.address, likelyVpn: VPN_NAME_PATTERNS.some((pattern) => pattern.test(name)) });
    }
  }
  return candidates.sort((a, b) => Number(b.likelyVpn) - Number(a.likelyVpn));
}

export const callbackHostInfoTool: ToolDefinition = {
  name: "callback_host_info",
  description:
    "List host-machine network interfaces and addresses ranked by likelihood of being reachable from a VPN-connected lab or CTF target, prioritizing tunnel interfaces. Use this before choosing a reverse-shell LHOST because the Kali container has a different network namespace from the host VPN.",
  inputSchema: { type: "object", properties: {} },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async () => {
    const candidates = rankInterfaces();
    if (!candidates.length) {
      return { ok: true, summary: "no non-internal network interfaces found", output: "(none)" };
    }
    const lines = candidates.map((candidate) => `${candidate.likelyVpn ? "* " : "  "}${candidate.interface}: ${candidate.address}`);
    const top = candidates[0];
    return {
      ok: true,
      summary: `${candidates.length} host network interface(s) found${top?.likelyVpn ? `, likely VPN LHOST: ${top.address}` : ""}`,
      output: lines.join("\n"),
      metadata: { candidates }
    };
  }
};
