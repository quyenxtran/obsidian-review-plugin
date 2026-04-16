export type ReviewStatus = "pending" | "accepted" | "rejected" | "stale" | "conflict";

export interface Suggestion {
  id: string;
  start: number;
  end: number;
  expectedOldText: string;
  newText: string;
  rationale?: string;
  status: ReviewStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

export interface ReviewGeneratorInfo {
  source: "codex";
  model?: string;
  generatedAt: string;
}

export interface ReviewPayload {
  schemaVersion: 1;
  notePath: string;
  baseHash: string;
  generator: ReviewGeneratorInfo;
  suggestions: Suggestion[];
}

export interface ReviewState {
  schemaVersion: 1;
  notePath: string;
  baseHash: string;
  currentHash: string;
  suggestions: Suggestion[];
  importedAt: string;
  updatedAt: string;
}

export type ReviewActionType =
  | "generate"
  | "import"
  | "edit"
  | "resolve"
  | "accept"
  | "reject"
  | "accept_all"
  | "reject_all"
  | "mark_stale"
  | "conflict";

export interface AuditEvent {
  eventType: ReviewActionType;
  notePath: string;
  reviewFile: string;
  timestamp: string;
  reviewer?: string;
  suggestionId?: string;
  fromStatus?: ReviewStatus;
  toStatus?: ReviewStatus;
  baseHash?: string;
  currentHash?: string;
  payloadGenerator?: string;
  appliedCount?: number;
  conflictedCount?: number;
  rejectedCount?: number;
}

export interface AiReviewSettings {
  reviewsFolder: string;
  auditLogPath: string;
  reviewerName: string;
  openAiApiKey: string;
  openAiEndpoint: string;
  openAiModel: string;
  defaultEditInstruction: string;
}

export const DEFAULT_SETTINGS: AiReviewSettings = {
  reviewsFolder: ".obsidian/ai-review",
  auditLogPath: ".obsidian/ai-review/review-log.ndjson",
  reviewerName: "",
  openAiApiKey: "",
  openAiEndpoint: "https://api.openai.com/v1/responses",
  openAiModel: "gpt-5.4-mini",
  defaultEditInstruction:
    "Revise the selected text for clarity, grammar, technical precision, and concision. Preserve meaning, markdown, citations, equations, and notation. Return only the revised replacement text with no commentary or quotation marks."
};
