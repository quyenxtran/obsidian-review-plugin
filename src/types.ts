export type ReviewSchemaVersion = 1;
export type ReviewTimestamp = string;
export type Sha256Hash = string;
export type ReviewGeneratorSource = "codex";

export const REVIEW_STATUSES = [
  "requested",
  "pending",
  "accepted",
  "rejected",
  "stale",
  "conflict"
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_ACTION_TYPES = [
  "request",
  "generate",
  "import",
  "edit",
  "resolve",
  "accept",
  "reject",
  "accept_all",
  "reject_all",
  "mark_stale",
  "conflict"
] as const;
export type ReviewActionType = (typeof REVIEW_ACTION_TYPES)[number];

export interface ReviewIdentity {
  notePath: string;
  baseHash: Sha256Hash;
}

export interface ReviewRange {
  start: number;
  end: number;
}

export interface ReviewSelection extends ReviewRange {
  text: string;
}

export interface Suggestion extends ReviewRange {
  id: string;
  requestId?: string;
  expectedOldText: string;
  newText: string;
  rationale?: string;
  status: ReviewStatus;
  createdAt: ReviewTimestamp;
  decidedAt?: ReviewTimestamp;
  decidedBy?: string;
}

export interface ReviewGeneratorInfo {
  source: ReviewGeneratorSource;
  model?: string;
  generatedAt: ReviewTimestamp;
}

export interface CodexSelectionRequest extends ReviewIdentity {
  schemaVersion: ReviewSchemaVersion;
  requestId: string;
  createdAt: ReviewTimestamp;
  instruction: string;
  contextBefore?: string;
  contextAfter?: string;
  selection: ReviewSelection;
}

export interface CodexSelectionResponse extends ReviewIdentity {
  schemaVersion: ReviewSchemaVersion;
  requestId: string;
  generator: ReviewGeneratorInfo;
  suggestion: Pick<Suggestion, "newText" | "rationale">;
}

export interface ReviewState extends ReviewIdentity {
  schemaVersion: ReviewSchemaVersion;
  currentHash: Sha256Hash;
  suggestions: Suggestion[];
  importedAt: ReviewTimestamp;
  updatedAt: ReviewTimestamp;
}

export interface AuditEvent {
  eventType: ReviewActionType;
  notePath: string;
  reviewFile: string;
  timestamp: ReviewTimestamp;
  reviewer?: string;
  suggestionId?: string;
  fromStatus?: ReviewStatus;
  toStatus?: ReviewStatus;
  baseHash?: Sha256Hash;
  currentHash?: Sha256Hash;
  payloadGenerator?: string;
  appliedCount?: number;
  conflictedCount?: number;
  rejectedCount?: number;
}

export interface AiReviewSettings {
  reviewsFolder: string;
  requestsFolder: string;
  responsesFolder: string;
  auditLogPath: string;
  reviewerName: string;
  defaultEditInstruction: string;
  autoLaunchCodex: boolean;
  codexCliCommand: string;
}

export interface AiReviewSettingsHost {
  settings: AiReviewSettings;
  saveSettings(): Promise<void>;
}

export const DEFAULT_SETTINGS: AiReviewSettings = {
  reviewsFolder: ".obsidian/ai-review",
  requestsFolder: ".obsidian/ai-review/requests",
  responsesFolder: ".obsidian/ai-review/responses",
  auditLogPath: ".obsidian/ai-review/review-log.ndjson",
  reviewerName: "",
  defaultEditInstruction:
    "Revise the selected text for clarity, grammar, technical precision, and concision. Preserve meaning, markdown, citations, equations, and notation. Return only the revised replacement text with no commentary or quotation marks.",
  autoLaunchCodex: true,
  codexCliCommand: "codex"
};
