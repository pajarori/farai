export const MCP_BACKBONE_SERVER_IDS = ["mitmproxy-mcp", "playwright"] as const;

const backbone = new Set<string>(MCP_BACKBONE_SERVER_IDS);

export function isMcpBackboneServer(serverID: string): boolean {
  return backbone.has(serverID);
}
