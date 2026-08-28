import type { ToolDefinition } from "../../types";
import { nmapScanTool, portScanTool } from "./nmap-scan";
import { httpRequestTool } from "./http-request";
import { dirEnumTool } from "./dir-enum";
import { exploitSearchTool } from "./exploit-search";
import { subdomainEnumTool } from "./subdomain-enum";

export const reconTools: ToolDefinition[] = [portScanTool, nmapScanTool, subdomainEnumTool, httpRequestTool, dirEnumTool, exploitSearchTool];
