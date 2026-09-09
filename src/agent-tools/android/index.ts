import type { ToolDefinition } from "../../types";
import { androidConnectTool, androidDevicesTool, androidShellTool, androidPackagesTool, androidDeviceInfoTool, androidLogcatTool } from "./device";
import { androidApkPullTool, androidInstallTool, androidAppStartTool, androidAppStopTool, androidDeeplinkTool, androidPullFileTool } from "./app";
import { androidDecompileTool, androidManifestTool, androidPermissionsTool, androidExportedComponentsTool, androidScanSecretsTool, androidGrepApkTool } from "./static";
import { androidUiDumpTool, androidUiHierarchyTool, androidScreenshotTool, androidUiTapTool, androidUiTapElementTool, androidUiTypeTool, androidUiSwipeTool, androidUiKeyTool, androidUiWindowSizeTool, androidUiWaitForTool } from "./ui";
import { androidFridaInstallTool, androidFridaStatusTool, androidFridaSetupTool, androidFridaPsTool, androidFridaRunTool, androidFridaBypassTool } from "./frida";

export const androidTools: ToolDefinition[] = [
  androidConnectTool,
  androidDevicesTool,
  androidShellTool,
  androidPackagesTool,
  androidDeviceInfoTool,
  androidLogcatTool,
  androidApkPullTool,
  androidInstallTool,
  androidAppStartTool,
  androidAppStopTool,
  androidDeeplinkTool,
  androidPullFileTool,
  androidDecompileTool,
  androidManifestTool,
  androidPermissionsTool,
  androidExportedComponentsTool,
  androidScanSecretsTool,
  androidGrepApkTool,
  androidUiDumpTool,
  androidUiHierarchyTool,
  androidScreenshotTool,
  androidUiTapTool,
  androidUiTapElementTool,
  androidUiTypeTool,
  androidUiSwipeTool,
  androidUiKeyTool,
  androidUiWindowSizeTool,
  androidUiWaitForTool,
  androidFridaInstallTool,
  androidFridaStatusTool,
  androidFridaSetupTool,
  androidFridaPsTool,
  androidFridaRunTool,
  androidFridaBypassTool
];
