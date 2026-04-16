import { MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { sha256 } from "./hash";
import { ReviewPersistence } from "./persistence";
import {
  DEFAULT_SETTINGS,
  type AiReviewSettings,
  type ReviewPayload,
  type ReviewState,
  type Suggestion
} from "./types";

export default class AiReviewPlugin extends Plugin {
  settings: AiReviewSettings = DEFAULT_SETTINGS;
  persistence!: ReviewPersistence;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.persistence = new ReviewPersistence(this.app, () => this.settings);

    this.addCommand({
      id: "ai-review-status",
      name: "AI Review: Show status",
      callback: () => {
        new Notice(`AI Review ready. Sidecar folder: ${this.settings.reviewsFolder}`);
      }
    });

    this.addCommand({
      id: "ai-review-import-json",
      name: "AI Review: Import suggestions from JSON",
      callback: async () => {
        await this.importSuggestionsFromJson();
      }
    });
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<AiReviewSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async importSuggestionsFromJson(): Promise<void> {
    const activeFile = this.getActiveMarkdownFile();
    if (!activeFile) {
      new Notice("Open a markdown note before importing suggestions.");
      return;
    }

    const payload = await this.pickReviewPayload();
    if (!payload) {
      return;
    }

    const activePath = normalizePath(activeFile.path);
    const payloadPath = normalizePath(payload.notePath);
    if (activePath !== payloadPath) {
      new Notice(`Payload is for "${payloadPath}", but active note is "${activePath}".`);
      return;
    }

    const content = await this.app.vault.cachedRead(activeFile);
    const currentHash = sha256(content);
    const stale = currentHash !== payload.baseHash;
    const now = new Date().toISOString();
    const suggestions = payload.suggestions.map((suggestion) => {
      return {
        ...suggestion,
        status: stale ? "stale" : "pending",
        createdAt: suggestion.createdAt || now,
        decidedAt: stale ? now : undefined,
        decidedBy: stale ? this.settings.reviewerName || undefined : undefined
      } satisfies Suggestion;
    });

    const state: ReviewState = {
      schemaVersion: 1,
      notePath: activePath,
      baseHash: payload.baseHash,
      currentHash,
      suggestions,
      importedAt: now,
      updatedAt: now
    };

    const reviewFile = await this.persistence.writeReviewState(state);
    await this.persistence.appendAuditEvent({
      eventType: "import",
      notePath: activePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      baseHash: payload.baseHash,
      currentHash,
      payloadGenerator: payload.generator.source
    });

    if (stale) {
      await this.persistence.appendAuditEvent({
        eventType: "mark_stale",
        notePath: activePath,
        reviewFile,
        timestamp: now,
        reviewer: this.settings.reviewerName || undefined,
        baseHash: payload.baseHash,
        currentHash,
        payloadGenerator: payload.generator.source
      });
      new Notice(`Imported ${suggestions.length} suggestions, but marked stale (hash mismatch).`);
      return;
    }

    new Notice(`Imported ${suggestions.length} suggestions.`);
  }

  private getActiveMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return null;
    }
    return view.file;
  }

  private async pickReviewPayload(): Promise<ReviewPayload | null> {
    const file = await this.pickJsonFile();
    if (!file) {
      return null;
    }
    const text = await file.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      new Notice("Could not parse JSON file.");
      return null;
    }

    try {
      return this.parseReviewPayload(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid review payload.";
      new Notice(message);
      return null;
    }
  }

  private parseReviewPayload(raw: unknown): ReviewPayload {
    if (!isObject(raw)) {
      throw new Error("Payload must be a JSON object.");
    }
    if (raw.schemaVersion !== 1) {
      throw new Error("Only schemaVersion 1 is supported.");
    }
    if (typeof raw.notePath !== "string" || !raw.notePath.trim()) {
      throw new Error("Payload notePath is required.");
    }
    if (typeof raw.baseHash !== "string" || !raw.baseHash.trim()) {
      throw new Error("Payload baseHash is required.");
    }
    if (!isObject(raw.generator) || raw.generator.source !== "codex") {
      throw new Error("Payload generator.source must be \"codex\".");
    }
    if (typeof raw.generator.generatedAt !== "string" || !raw.generator.generatedAt.trim()) {
      throw new Error("Payload generator.generatedAt is required.");
    }
    if (!Array.isArray(raw.suggestions)) {
      throw new Error("Payload suggestions must be an array.");
    }

    const now = new Date().toISOString();
    const suggestions = raw.suggestions.map((item, index) => {
      if (!isObject(item)) {
        throw new Error(`Suggestion at index ${index} must be an object.`);
      }
      if (typeof item.start !== "number" || typeof item.end !== "number") {
        throw new Error(`Suggestion at index ${index} must include numeric start/end.`);
      }
      if (item.start < 0 || item.end < item.start) {
        throw new Error(`Suggestion at index ${index} has invalid offsets.`);
      }
      if (typeof item.expectedOldText !== "string" || typeof item.newText !== "string") {
        throw new Error(`Suggestion at index ${index} must include text fields.`);
      }
      if (item.rationale !== undefined && typeof item.rationale !== "string") {
        throw new Error(`Suggestion at index ${index} has invalid rationale.`);
      }
      if (item.id !== undefined && typeof item.id !== "string") {
        throw new Error(`Suggestion at index ${index} has invalid id.`);
      }
      if (item.createdAt !== undefined && typeof item.createdAt !== "string") {
        throw new Error(`Suggestion at index ${index} has invalid createdAt.`);
      }

      return {
        id: item.id ?? `s-${index + 1}`,
        start: item.start,
        end: item.end,
        expectedOldText: item.expectedOldText,
        newText: item.newText,
        rationale: item.rationale,
        status: "pending",
        createdAt: item.createdAt ?? now
      } satisfies Suggestion;
    });

    return {
      schemaVersion: 1,
      notePath: raw.notePath,
      baseHash: raw.baseHash,
      generator: {
        source: "codex",
        model: typeof raw.generator.model === "string" ? raw.generator.model : undefined,
        generatedAt: raw.generator.generatedAt
      },
      suggestions
    };
  }

  private async pickJsonFile(): Promise<File | null> {
    return await new Promise<File | null>((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = () => {
        resolve(input.files?.item(0) ?? null);
      };
      input.click();
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
