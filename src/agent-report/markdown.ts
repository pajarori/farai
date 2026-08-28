import type { CampaignDossier, Evidence, Finding, MemoryItem, Note, Session, TodoItem } from "../types";

export function renderCtfNotes(input: {
  session: Session;
  evidence: Evidence[];
  findings: Finding[];
  notes?: Note[];
  todos?: TodoItem[];
  memory?: MemoryItem[];
  campaign?: CampaignDossier;
}): string {
  const lines = [
    `# ${input.session.title ?? "Farai Session"} Notes`,
    "",
    `- Session: ${input.session.id}`,
    `- Mode: ${input.session.mode}`,
    ...(input.campaign ? [`- Campaign: ${input.campaign.campaign.name} (${input.campaign.campaign.kind}/${input.campaign.campaign.status})`] : []),
    "",
    "## Notes",
    ""
  ];
  if (input.campaign) {
    lines.push("## Attack Surface", "");
    for (const asset of input.campaign.assets) lines.push(`- ${asset.canonical} [${asset.technologies.join(", ") || "technology unknown"}]`);
    lines.push("", "## Hypotheses", "");
    for (const hypothesis of input.campaign.hypotheses) lines.push(`- [${hypothesis.status}] ${hypothesis.title} (${hypothesis.category}, confidence ${hypothesis.confidence.toFixed(2)}) -> ${hypothesis.nextTest}`);
  }
  for (const note of input.notes ?? []) {
    lines.push(`- ${note.id}: ${note.text}`);
  }
  lines.push("", "## Todos", "");
  for (const todo of input.todos ?? []) lines.push(`- [${todo.status === "done" ? "x" : " "}] ${todo.text} (${todo.priority})`);
  lines.push("", "## Memory", "");
  for (const item of input.memory ?? []) lines.push(`- ${item.kind}/${item.key}: ${JSON.stringify(item.value)}`);
  lines.push(
    "",
    "## Evidence",
    ""
  );
  for (const item of input.evidence) {
    lines.push(`- ${item.id}: ${item.title} — ${item.summary}`);
  }
  lines.push("", "## Findings", "");
  for (const finding of input.findings) {
    lines.push(
      `### ${finding.title}`,
      "",
      `- Severity: ${finding.severity}`,
      `- Target: ${finding.target}`,
      `- Evidence: ${finding.evidenceIds.join(", ") || "none linked"}`,
      "",
      "#### Impact",
      "",
      finding.impact || "Not recorded.",
      "",
      "#### Reproduction",
      "",
      finding.reproduction || "Not recorded.",
      "",
      "#### Remediation",
      "",
      finding.remediation || "Not recorded.",
      ""
    );
  }
  return lines.join("\n");
}
