import type { ToolDefinition } from "../../types";
import { networkScanTool } from "./port-scan";
import { httpRequestTool } from "./http-request";
import { dirEnumTool } from "./dir-enum";
import { subdomainEnumTool } from "./subdomain-enum";
import { dnsProbeTool } from "./dns-probe";
import { httpProbeTool } from "./http-probe";
import { tlsProbeTool } from "./tls-probe";
import { urlDiscoverTool } from "./url-discover";
import { vulnerabilityLookupTool } from "./vulnerability-lookup";
import { vulnerabilityScanTool } from "./vulnerability-scan";
import { webCrawlTool } from "./web-crawl";

export const reconTools: ToolDefinition[] = [
  networkScanTool,
  subdomainEnumTool,
  dnsProbeTool,
  httpProbeTool,
  tlsProbeTool,
  urlDiscoverTool,
  webCrawlTool,
  vulnerabilityScanTool,
  vulnerabilityLookupTool,
  httpRequestTool,
  dirEnumTool
];
