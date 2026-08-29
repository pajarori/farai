import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { loadSkill } from "../../agent-skills/registry";

export const skillLoadTool: ToolDefinition = {
  name: "skill_load",
  description: "Load one exact agent skill or one supporting resource from that skill. Skills are focused workflows; use knowledge_search for reference facts and large security corpora.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "exact skill name from the available skills catalog" },
      resource: { type: "string", description: "optional relative path listed by a previous skill_load result" }
    }
  },
  mutates: false,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const name = asString(args.name, "name");
    const resource = typeof args.resource === "string" ? args.resource : undefined;
    const skill = loadSkill(name, { workspace: context.rootWorkspace ?? context.workspace, ...(resource ? { resource } : {}) });
    if (!skill) {
      return {
        ok: false,
        summary: resource ? `skill resource not found: ${name}/${resource}` : `skill not found: ${name}`,
        output: resource
          ? "use an exact relative resource path listed by skill_load"
          : "use an exact name from the available skills catalog"
      };
    }
    if (skill.resource) {
      return {
        ok: true,
        summary: `loaded ${skill.name}/${skill.resource.path}`,
        output: [
          `# skill resource: ${skill.name}/${skill.resource.path}`,
          "use this resource only for the current task path selected by the parent skill.",
          skill.resource.content
        ].join("\n\n"),
        metadata: {
          instructionSource: "skill",
          skillName: skill.name,
          skillHash: skill.hash,
          resourcePath: skill.resource.path,
          resourceHash: skill.resource.hash,
          skillSource: skill.source
        }
      };
    }
    const details = [
      `# loaded skill: ${skill.name}`,
      skill.description,
      `source: ${skill.source}`,
      `directory: ${skill.directory}`,
      ...(skill.compatibility ? [`compatibility: ${skill.compatibility}`] : []),
      ...(skill.resources.length ? ["supporting resources:", ...skill.resources.map((path) => `- ${path}`)] : []),
      ...(skill.resources.length ? ["load only the resource routed by these instructions or required by the current task; do not preload every resource."] : []),
      "## instructions",
      skill.body
    ];
    return {
      ok: true,
      summary: `loaded skill ${skill.name}`,
      output: details.join("\n\n"),
      metadata: { instructionSource: "skill", skillName: skill.name, skillHash: skill.hash, skillSource: skill.source }
    };
  }
};
