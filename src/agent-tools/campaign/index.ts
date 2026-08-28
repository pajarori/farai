import { campaignCreateTool } from "./create";
import { campaignAssetTool } from "./asset";
import { campaignObserveTool } from "./observe";
import { campaignHypothesisTool } from "./hypothesis";
import { campaignSearchTool } from "./search";
import { campaignVerifyTool } from "./verify";
import { campaignNextActionTool } from "./next-action";
import { campaignDispatchTool } from "./dispatch";
import { campaignTestAttemptTool } from "./test-attempt";

export const campaignTools = [campaignCreateTool, campaignAssetTool, campaignObserveTool, campaignHypothesisTool, campaignSearchTool, campaignVerifyTool, campaignNextActionTool, campaignDispatchTool, campaignTestAttemptTool];
