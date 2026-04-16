export type ReviewStatus =
  | "requested"
  | "pending"
  | "accepted"
  | "rejected"
  | "stale"
  | "conflict";

export interface Suggestion {
  id: string;
  requestId?: string;
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

export interface CodexSelectionRequest {
  schemaVersion: 1;
  requestId: string;
  notePath: string;
  baseHash: string;
  createdAt: string;
  instruction: string;
  contextBefore?: string;
  contextAfter?: string;
  selection: {
    start: number;
    end: number;
    text: string;
  };
}

export interface CodexSelectionResponse {
  schemaVersion: 1;
  requestId: string;
  notePath: string;
  baseHash: string;
  generator: ReviewGeneratorInfo;
  suggestion: {
    newText: string;
    rationale?: string;
  };
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
  | "request"
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
  requestsFolder: string;
  responsesFolder: string;
  auditLogPath: string;
  reviewerName: string;
  defaultEditInstruction: string;
}

export const DEFAULT_SETTINGS: AiReviewSettings = {
  reviewsFolder: ".obsidian/ai-review",
  requestsFolder: ".obsidian/ai-review/requests",
  responsesFolder: ".obsidian/ai-review/responses",
  auditLogPath: ".obsidian/ai-review/review-log.ndjson",
  reviewerName: "",
  defaultEditInstruction:
    "Revise the selected text for clarity, grammar, technical precision, and concision. Preserve meaning, markdown, citations, equations, and notation. Return only the revised replacement text with no commentary or quotation marks."
};
