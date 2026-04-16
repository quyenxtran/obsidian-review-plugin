import { MarkdownView, Modal, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { sha256 } from "./hash";
import { ReviewPersistence } from "./persistence";
import {
  createReviewDecorationsExtension,
  type SuggestionAction,
  refreshReviewEffect
} from "./reviewDecorations";
import { AiReviewSettingTab } from "./settingsTab";
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
  currentReviewState: ReviewState | null = null;
  activeNotePath: string | null = null;
  selectedSuggestionId: string | null = null;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.persistence = new ReviewPersistence(this.app, () => this.settings);
    this.registerEditorExtension(createReviewDecorationsExtension(this));
    this.addSettingTab(new AiReviewSettingTab(this.app, this));

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

    this.addCommand({
      id: "ai-review-next-suggestion",
      name: "AI Review: Next suggestion",
      callback: () => {
        this.moveSuggestionSelection(1);
      }
    });

    this.addCommand({
      id: "ai-review-previous-suggestion",
      name: "AI Review: Previous suggestion",
      callback: () => {
        this.moveSuggestionSelection(-1);
      }
    });

    this.addCommand({
      id: "ai-review-accept-current",
      name: "AI Review: Accept current suggestion",
      callback: async () => {
        const suggestion = this.getCurrentPendingSuggestion();
        if (!suggestion) {
          new Notice("No pending suggestion selected.");
          return;
        }
        await this.onSuggestionAction(suggestion.id, "accept");
      }
    });

    this.addCommand({
      id: "ai-review-reject-current",
      name: "AI Review: Reject current suggestion",
      callback: async () => {
        const suggestion = this.getCurrentPendingSuggestion();
        if (!suggestion) {
          new Notice("No pending suggestion selected.");
          return;
        }
        await this.onSuggestionAction(suggestion.id, "reject");
      }
    });

    this.addCommand({
      id: "ai-review-accept-all-pending",
      name: "AI Review: Accept all pending",
      callback: async () => {
        await this.acceptAllPendingSuggestions();
      }
    });

    this.addCommand({
      id: "ai-review-reject-all-pending",
      name: "AI Review: Reject all pending",
      callback: async () => {
        await this.rejectAllPendingSuggestions();
      }
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", async () => {
        await this.loadStateForActiveFile();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", async () => {
        await this.loadStateForActiveFile();
      })
    );
    await this.loadStateForActiveFile();
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
    this.currentReviewState = state;
    this.activeNotePath = activePath;
    this.selectedSuggestionId = this.currentReviewState.suggestions.find((item) => item.status === "pending")?.id ?? null;
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
      this.refreshActiveEditorDecorations();
      return;
    }

    new Notice(`Imported ${suggestions.length} suggestions.`);
    this.refreshActiveEditorDecorations();
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

  async loadStateForActiveFile(): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      this.currentReviewState = null;
      this.activeNotePath = null;
      this.selectedSuggestionId = null;
      return;
    }

    const notePath = normalizePath(file.path);
    this.activeNotePath = notePath;
    this.currentReviewState = await this.persistence.readReviewState(notePath);
    this.selectedSuggestionId =
      this.currentReviewState?.suggestions.find((item) => item.status === "pending")?.id ?? null;
    this.refreshActiveEditorDecorations();
  }

  getRenderableSuggestions(): Suggestion[] {
    if (!this.currentReviewState) {
      return [];
    }
    return this.currentReviewState.suggestions.filter((suggestion) => {
      return (
        suggestion.status === "pending" ||
        suggestion.status === "stale" ||
        suggestion.status === "conflict"
      );
    });
  }

  async onSuggestionAction(id: string, action: SuggestionAction): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      new Notice("No review state loaded for this note.");
      return;
    }

    const suggestion = this.currentReviewState.suggestions.find((item) => item.id === id);
    if (!suggestion) {
      new Notice(`Suggestion ${id} was not found.`);
      return;
    }
    if (suggestion.status !== "pending") {
      new Notice(`Suggestion ${id} is already ${suggestion.status}.`);
      return;
    }

    if (action === "reject") {
      await this.markSuggestionRejected(suggestion);
      this.selectFallbackSuggestion();
      return;
    }

    await this.applySingleSuggestion(suggestion);
    this.selectFallbackSuggestion();
  }

  async onSuggestionEdit(id: string): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      new Notice("No review state loaded for this note.");
      return;
    }

    const suggestion = this.currentReviewState.suggestions.find((item) => item.id === id);
    if (!suggestion) {
      new Notice(`Suggestion ${id} was not found.`);
      return;
    }
    if (suggestion.status !== "pending") {
      new Notice(`Only pending suggestions can be edited.`);
      return;
    }

    const editedText = await this.openSuggestionEditModal(suggestion);
    if (editedText === null || editedText === suggestion.newText) {
      return;
    }

    suggestion.newText = editedText;
    this.currentReviewState.updatedAt = new Date().toISOString();
    const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
    await this.persistence.appendAuditEvent({
      eventType: "edit",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: this.currentReviewState.updatedAt,
      reviewer: this.settings.reviewerName || undefined,
      suggestionId: suggestion.id,
      fromStatus: suggestion.status,
      toStatus: suggestion.status,
      baseHash: this.currentReviewState.baseHash,
      currentHash: this.currentReviewState.currentHash
    });
    this.refreshActiveEditorDecorations();
    new Notice(`Updated suggestion ${suggestion.id}.`);
  }

  private refreshActiveEditorDecorations(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = (view?.editor as unknown as { cm?: { dispatch: (spec: unknown) => void } }).cm;
    if (!cm) {
      return;
    }
    cm.dispatch({
      effects: [refreshReviewEffect.of(undefined)]
    });
  }

  private async openSuggestionEditModal(suggestion: Suggestion): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
      new EditSuggestionModal(this.app, suggestion.newText, resolve).open();
    });
  }

  private async markSuggestionRejected(suggestion: Suggestion): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      return;
    }

    const now = new Date().toISOString();
    const fromStatus = suggestion.status;
    suggestion.status = "rejected";
    suggestion.decidedAt = now;
    suggestion.decidedBy = this.settings.reviewerName || undefined;
    this.currentReviewState.updatedAt = now;
    const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
    await this.persistence.appendAuditEvent({
      eventType: "reject",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      suggestionId: suggestion.id,
      fromStatus,
      toStatus: "rejected",
      baseHash: this.currentReviewState.baseHash,
      currentHash: this.currentReviewState.currentHash
    });
    this.refreshActiveEditorDecorations();
    new Notice(`Rejected suggestion ${suggestion.id}.`);
  }

  private async applySingleSuggestion(suggestion: Suggestion): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file || !this.currentReviewState || !this.activeNotePath) {
      new Notice("No active markdown file.");
      return;
    }

    const currentText = await this.app.vault.cachedRead(file);
    const result = applySuggestionsDeterministically(currentText, [suggestion]);
    const now = new Date().toISOString();

    if (result.conflictedIds.has(suggestion.id)) {
      const fromStatus = suggestion.status;
      suggestion.status = "conflict";
      suggestion.decidedAt = now;
      suggestion.decidedBy = this.settings.reviewerName || undefined;
      this.currentReviewState.updatedAt = now;
      const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
      await this.persistence.appendAuditEvent({
        eventType: "conflict",
        notePath: this.activeNotePath,
        reviewFile,
        timestamp: now,
        reviewer: this.settings.reviewerName || undefined,
        suggestionId: suggestion.id,
        fromStatus,
        toStatus: "conflict",
        baseHash: this.currentReviewState.baseHash,
        currentHash: this.currentReviewState.currentHash
      });
      this.refreshActiveEditorDecorations();
      new Notice(`Conflict for ${suggestion.id}. Expected text did not match current note.`);
      return;
    }

    if (!result.appliedIds.has(suggestion.id)) {
      new Notice(`Suggestion ${suggestion.id} was not applied.`);
      return;
    }

    await this.app.vault.modify(file, result.nextText);

    const fromStatus = suggestion.status;
    suggestion.status = "accepted";
    suggestion.decidedAt = now;
    suggestion.decidedBy = this.settings.reviewerName || undefined;
    const delta = suggestion.newText.length - (suggestion.end - suggestion.start);
    const rebasedConflicts = this.rebasePendingSuggestionsAfterAccepted(suggestion, delta, now);
    this.currentReviewState.currentHash = sha256(result.nextText);
    this.currentReviewState.updatedAt = now;
    const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
    await this.persistence.appendAuditEvent({
      eventType: "accept",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      suggestionId: suggestion.id,
      fromStatus,
      toStatus: "accepted",
      baseHash: this.currentReviewState.baseHash,
      currentHash: this.currentReviewState.currentHash
    });
    for (const conflicted of rebasedConflicts) {
      await this.persistence.appendAuditEvent({
        eventType: "conflict",
        notePath: this.activeNotePath,
        reviewFile,
        timestamp: now,
        reviewer: this.settings.reviewerName || undefined,
        suggestionId: conflicted.id,
        fromStatus: "pending",
        toStatus: "conflict",
        baseHash: this.currentReviewState.baseHash,
        currentHash: this.currentReviewState.currentHash
      });
    }
    this.refreshActiveEditorDecorations();
    if (rebasedConflicts.length > 0) {
      new Notice(
        `Accepted suggestion ${suggestion.id}. ${rebasedConflicts.length} overlapping suggestion(s) marked conflict.`
      );
      return;
    }
    new Notice(`Accepted suggestion ${suggestion.id}.`);
  }

  private async acceptAllPendingSuggestions(): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      new Notice("No review state loaded for this note.");
      return;
    }
    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("No active markdown file.");
      return;
    }

    const pending = this.getPendingSuggestionsSorted();
    if (pending.length === 0) {
      new Notice("No pending suggestions.");
      return;
    }

    const currentText = await this.app.vault.cachedRead(file);
    const result = applySuggestionsDeterministically(currentText, pending);
    const now = new Date().toISOString();
    let appliedCount = 0;
    let conflictedCount = 0;

    for (const suggestion of pending) {
      if (result.appliedIds.has(suggestion.id)) {
        suggestion.status = "accepted";
        suggestion.decidedAt = now;
        suggestion.decidedBy = this.settings.reviewerName || undefined;
        appliedCount += 1;
      } else if (result.conflictedIds.has(suggestion.id)) {
        suggestion.status = "conflict";
        suggestion.decidedAt = now;
        suggestion.decidedBy = this.settings.reviewerName || undefined;
        conflictedCount += 1;
      }
    }

    if (appliedCount > 0) {
      await this.app.vault.modify(file, result.nextText);
      this.currentReviewState.currentHash = sha256(result.nextText);
    }
    this.currentReviewState.updatedAt = now;
    const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
    await this.persistence.appendAuditEvent({
      eventType: "accept_all",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      baseHash: this.currentReviewState.baseHash,
      currentHash: this.currentReviewState.currentHash,
      appliedCount,
      conflictedCount
    });

    this.selectFallbackSuggestion();
    this.refreshActiveEditorDecorations();
    new Notice(`Accepted ${appliedCount} suggestions. Conflicts: ${conflictedCount}.`);
  }

  private async rejectAllPendingSuggestions(): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      new Notice("No review state loaded for this note.");
      return;
    }
    const pending = this.getPendingSuggestionsSorted();
    if (pending.length === 0) {
      new Notice("No pending suggestions.");
      return;
    }

    const now = new Date().toISOString();
    for (const suggestion of pending) {
      suggestion.status = "rejected";
      suggestion.decidedAt = now;
      suggestion.decidedBy = this.settings.reviewerName || undefined;
    }
    this.currentReviewState.updatedAt = now;
    const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
    await this.persistence.appendAuditEvent({
      eventType: "reject_all",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      baseHash: this.currentReviewState.baseHash,
      currentHash: this.currentReviewState.currentHash,
      rejectedCount: pending.length
    });

    this.selectFallbackSuggestion();
    this.refreshActiveEditorDecorations();
    new Notice(`Rejected ${pending.length} suggestions.`);
  }

  private getPendingSuggestionsSorted(): Suggestion[] {
    if (!this.currentReviewState) {
      return [];
    }
    return this.currentReviewState.suggestions
      .filter((suggestion) => suggestion.status === "pending")
      .sort((a, b) => {
        if (a.start !== b.start) {
          return a.start - b.start;
        }
        return a.end - b.end;
      });
  }

  private getCurrentPendingSuggestion(): Suggestion | null {
    const pending = this.getPendingSuggestionsSorted();
    if (pending.length === 0) {
      return null;
    }
    if (!this.selectedSuggestionId) {
      this.selectedSuggestionId = pending[0]?.id ?? null;
      return pending[0] ?? null;
    }
    const selected = pending.find((item) => item.id === this.selectedSuggestionId);
    if (selected) {
      return selected;
    }
    this.selectedSuggestionId = pending[0]?.id ?? null;
    return pending[0] ?? null;
  }

  private moveSuggestionSelection(direction: 1 | -1): void {
    const pending = this.getPendingSuggestionsSorted();
    if (pending.length === 0) {
      new Notice("No pending suggestions.");
      return;
    }

    const currentIndex = pending.findIndex((item) => item.id === this.selectedSuggestionId);
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + direction + pending.length) % pending.length;
    const next = pending[nextIndex];
    if (!next) {
      return;
    }
    this.selectedSuggestionId = next.id;
    this.jumpToSuggestion(next);
    this.refreshActiveEditorDecorations();
    new Notice(`Selected suggestion ${next.id} (${nextIndex + 1}/${pending.length}).`);
  }

  private jumpToSuggestion(suggestion: Suggestion): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }
    const editor = view.editor;
    const pos = editor.offsetToPos(Math.max(0, suggestion.start));
    editor.setCursor(pos);
    editor.scrollIntoView({ from: pos, to: pos }, true);
  }

  private selectFallbackSuggestion(): void {
    const next = this.getPendingSuggestionsSorted()[0];
    this.selectedSuggestionId = next?.id ?? null;
    if (next) {
      this.jumpToSuggestion(next);
    }
  }

  private rebasePendingSuggestionsAfterAccepted(
    accepted: Suggestion,
    delta: number,
    timestamp: string
  ): Suggestion[] {
    if (!this.currentReviewState) {
      return [];
    }

    const conflicts: Suggestion[] = [];
    for (const suggestion of this.currentReviewState.suggestions) {
      if (suggestion.id === accepted.id || suggestion.status !== "pending") {
        continue;
      }

      if (suggestion.end <= accepted.start) {
        continue;
      }

      if (suggestion.start >= accepted.end) {
        suggestion.start += delta;
        suggestion.end += delta;
        continue;
      }

      suggestion.status = "conflict";
      suggestion.decidedAt = timestamp;
      suggestion.decidedBy = this.settings.reviewerName || undefined;
      conflicts.push(suggestion);
    }

    return conflicts;
  }
}

class EditSuggestionModal extends Modal {
  constructor(
    app: Plugin["app"],
    private readonly initialText: string,
    private readonly onResolve: (value: string | null) => void
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("ai-review-edit-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: "Edit suggestion" });

    const textarea = contentEl.createEl("textarea", {
      cls: "ai-review-edit-textarea"
    });
    textarea.value = this.initialText;
    textarea.rows = 10;
    textarea.focus();
    textarea.select();

    const buttonRow = contentEl.createDiv({ cls: "ai-review-edit-actions" });

    const cancelButton = buttonRow.createEl("button", { text: "Cancel" });
    cancelButton.onclick = () => {
      this.onResolve(null);
      this.close();
    };

    const saveButton = buttonRow.createEl("button", {
      text: "Save",
      cls: "mod-cta"
    });
    saveButton.onclick = () => {
      this.onResolve(textarea.value);
      this.close();
    };

    textarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        this.onResolve(textarea.value);
        this.close();
      }
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function applySuggestionsDeterministically(
  content: string,
  suggestions: Suggestion[]
): { nextText: string; appliedIds: Set<string>; conflictedIds: Set<string> } {
  const sorted = [...suggestions].sort((a, b) => {
    if (a.start !== b.start) {
      return b.start - a.start;
    }
    return b.end - a.end;
  });

  let working = content;
  const appliedIds = new Set<string>();
  const conflictedIds = new Set<string>();

  for (const suggestion of sorted) {
    if (suggestion.start < 0 || suggestion.end < suggestion.start || suggestion.end > working.length) {
      conflictedIds.add(suggestion.id);
      continue;
    }
    const found = working.slice(suggestion.start, suggestion.end);
    if (found !== suggestion.expectedOldText) {
      conflictedIds.add(suggestion.id);
      continue;
    }
    working =
      working.slice(0, suggestion.start) + suggestion.newText + working.slice(suggestion.end);
    appliedIds.add(suggestion.id);
  }

  return { nextText: working, appliedIds, conflictedIds };
}
