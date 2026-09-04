export type ContentArtifact = {
  url: string;
  sha256: string;
  size: number;
  schemaVersion?: number;
};

export type ContentManifest = {
  schemaVersion: 1;
  contentVersion: string;
  generatedAt: string;
  sourceCommit?: string;
  minFaraiVersion?: string;
  releaseNotes?: string;
  knowledge?: ContentArtifact;
  skills?: ContentArtifact;
};

export type ActiveContent = {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  sourceCommit?: string;
  activatedAt: string;
  manifestUrl: string;
  previousVersion?: string;
  knowledge: boolean;
  skills: boolean;
};

export type ContentUpdateStatus = {
  state: "disabled" | "unavailable" | "up_to_date" | "update_available" | "incompatible" | "error";
  active?: ActiveContent;
  manifest?: ContentManifest;
  manifestUrl: string;
  fromCache: boolean;
  error?: string;
};

export type AppliedContentUpdate = {
  version: string;
  sourceCommit?: string;
  previousVersion?: string;
  knowledge: boolean;
  skills: boolean;
  path: string;
};
