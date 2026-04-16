import { Editor, MarkdownView, Menu, Modal, Notice, Plugin, TFile, normalizePath } from "obsidian";
import { MapMode, type ChangeDesc } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";
import * as nodePath from "path";
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
  type CodexSelectionRequest,
  type CodexSelectionResponse,
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
  private suppressNextDocumentRebase = false;
  private persistReviewStateTimer: number | null = null;
  private readonly launchedWatcherPids = new Map<string, number>();

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
      id: "ai-review-suggest-selection",
      name: "AI Review: Request Codex suggestion for selection",
      callback: async () => {
        await this.createSelectionRequest();
      }
    });

    this.addCommand({
      id: "ai-review-check-responses",
      name: "AI Review: Check for Codex responses",
      callback: async () => {
        await this.importCodexResponsesForActiveFile();
      }
    });

    this.addCommand({
      id: "ai-review-import-json",
      name: "AI Review: Import suggestions from JSON (legacy)",
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
      (this.app.workspace as unknown as {
        on: (
          name: string,
          callback: (menu: Menu, editor: Editor, view: MarkdownView) => void
        ) => unknown;
      }).on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        const selectedText = editor.getSelection();
        if (!selectedText.trim()) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("AI Review Selection")
            .setIcon("sparkles")
            .onClick(() => {
              void this.createSelectionRequest(view, editor);
            });
        });
      }) as never
    );
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
    this.registerInterval(
      window.setInterval(() => {
        void this.importCodexResponsesForActiveFile();
      }, 4000)
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

  private async createSelectionRequest(
    providedView?: MarkdownView,
    providedEditor?: Editor
  ): Promise<void> {
    const view = providedView ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice("Open a markdown note before creating a Codex request.");
      return;
    }

    const editor = providedEditor ?? view.editor;
    const selectedText = editor.getSelection();
    if (!selectedText.trim()) {
      new Notice("Select text in the note first.");
      return;
    }

    const selectionStart = editor.posToOffset(editor.getCursor("from"));
    const selectionEnd = editor.posToOffset(editor.getCursor("to"));
    if (selectionStart === undefined || selectionEnd === undefined || selectionEnd < selectionStart) {
      new Notice("Could not determine the selected text range.");
      return;
    }

    const notePath = normalizePath(view.file.path);
    const noteText = editor.getValue();
    const currentHash = sha256(noteText);
    const state = await this.ensureReviewStateForNote(notePath, currentHash);
    const now = new Date().toISOString();
    const currentTarget = noteText.slice(selectionStart, selectionEnd);
    if (currentTarget !== selectedText) {
      new Notice("The selected text changed before generation completed. Try again.");
      return;
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const contextBefore = noteText.slice(Math.max(0, selectionStart - 500), selectionStart);
    const contextAfter = noteText.slice(selectionEnd, Math.min(noteText.length, selectionEnd + 500));

    const replacedCount = await this.replaceOverlappingSuggestions(
      state,
      selectionStart,
      selectionEnd,
      now
    );
    const suggestion: Suggestion = {
      id: requestId,
      requestId,
      start: selectionStart,
      end: selectionEnd,
      expectedOldText: selectedText,
      newText: "",
      status: "requested",
      createdAt: now
    };
    const request: CodexSelectionRequest = {
      schemaVersion: 1,
      requestId,
      notePath,
      baseHash: currentHash,
      createdAt: now,
      instruction: this.settings.defaultEditInstruction,
      contextBefore,
      contextAfter,
      selection: {
        start: selectionStart,
        end: selectionEnd,
        text: selectedText
      }
    };

    state.suggestions.push(suggestion);
    state.currentHash = currentHash;
    state.updatedAt = now;
    if (!state.importedAt) {
      state.importedAt = now;
    }
    this.currentReviewState = state;
    this.activeNotePath = notePath;
    this.selectedSuggestionId = suggestion.id;
    const requestFile = await this.persistence.writeSelectionRequest(request);
    const responseFile = this.persistence.getResponseFilePath(requestId);
    const absoluteNotePath = this.getAbsoluteNotePath(view.file);
    const responseTemplateFile = await this.persistence.writeResponseTemplate(
      requestId,
      buildCodexResponseTemplate(request)
    );
    const launchGuideFile = await this.persistence.writeLaunchGuide(
      requestId,
      buildCodexLaunchGuide(
        request,
        requestFile,
        responseFile,
        responseTemplateFile,
        absoluteNotePath
      )
    );
    const reviewFile = await this.persistence.writeReviewState(state);
    await this.persistence.appendAuditEvent({
      eventType: "request",
      notePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      suggestionId: suggestion.id,
      toStatus: "requested",
      baseHash: state.baseHash,
      currentHash: state.currentHash
    });
    this.refreshActiveEditorDecorations();
    const suffix = replacedCount > 0 ? ` Replaced ${replacedCount} overlapping suggestion(s).` : "";
    await this.maybeLaunchCodexWatcherForFile(view.file);
    new Notice(`Created Codex request.${suffix} Response expected in ${this.settings.responsesFolder}.`);
    console.info("AI Review request file:", requestFile);
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

  private async ensureReviewStateForNote(
    notePath: string,
    currentHash: string
  ): Promise<ReviewState> {
    if (this.currentReviewState && this.activeNotePath === notePath) {
      this.currentReviewState.currentHash = currentHash;
      return this.currentReviewState;
    }

    const existing = await this.persistence.readReviewState(notePath);
    if (existing) {
      existing.currentHash = currentHash;
      this.currentReviewState = existing;
      this.activeNotePath = notePath;
      return existing;
    }

    const now = new Date().toISOString();
    const created: ReviewState = {
      schemaVersion: 1,
      notePath,
      baseHash: currentHash,
      currentHash,
      suggestions: [],
      importedAt: now,
      updatedAt: now
    };
    this.currentReviewState = created;
    this.activeNotePath = notePath;
    return created;
  }

  getRenderableSuggestions(): Suggestion[] {
    if (!this.currentReviewState) {
      return [];
    }
    return this.currentReviewState.suggestions.filter((suggestion) => {
      return (
        suggestion.status === "pending" ||
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
    if (action === "reject" && (suggestion.status === "pending" || suggestion.status === "conflict" || suggestion.status === "requested")) {
      await this.markSuggestionRejected(suggestion);
      this.selectFallbackSuggestion();
      return;
    }

    if (suggestion.status !== "pending") {
      new Notice(`Suggestion ${id} is already ${suggestion.status}.`);
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
    if (suggestion.status !== "pending" && suggestion.status !== "conflict") {
      new Notice(`Only pending or conflicted suggestions can be edited.`);
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

  async onSuggestionResolve(id: string): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      new Notice("No review state loaded for this note.");
      return;
    }

    const suggestion = this.currentReviewState.suggestions.find((item) => item.id === id);
    if (!suggestion) {
      new Notice(`Suggestion ${id} was not found.`);
      return;
    }
    if (suggestion.status !== "conflict") {
      new Notice(`Suggestion ${id} is not conflicted.`);
      return;
    }

    const file = this.getActiveMarkdownFile();
    if (!file) {
      new Notice("No active markdown file.");
      return;
    }

    const currentText = await this.app.vault.cachedRead(file);
    const start = Math.max(0, Math.min(suggestion.start, currentText.length));
    const end = Math.max(start, Math.min(suggestion.end, currentText.length));
    const currentTarget = currentText.slice(start, end);
    if (!currentTarget) {
      new Notice(`Suggestion ${id} cannot be resolved because the current target range is empty.`);
      return;
    }

    const previousStatus = suggestion.status;
    suggestion.start = start;
    suggestion.end = end;
    suggestion.expectedOldText = currentTarget;
    suggestion.status = "pending";
    suggestion.decidedAt = undefined;
    suggestion.decidedBy = undefined;
    this.currentReviewState.updatedAt = new Date().toISOString();
    const reviewFile = await this.persistence.writeReviewState(this.currentReviewState);
    await this.persistence.appendAuditEvent({
      eventType: "resolve",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: this.currentReviewState.updatedAt,
      reviewer: this.settings.reviewerName || undefined,
      suggestionId: suggestion.id,
      fromStatus: previousStatus,
      toStatus: "pending",
      baseHash: this.currentReviewState.baseHash,
      currentHash: this.currentReviewState.currentHash
    });
    this.refreshActiveEditorDecorations();
    new Notice(`Resolved suggestion ${suggestion.id}. You can accept it now.`);
  }

  async onEditorDocumentChanged(update: ViewUpdate): Promise<void> {
    if (!this.currentReviewState || !this.activeNotePath) {
      return;
    }
    if (this.suppressNextDocumentRebase) {
      this.suppressNextDocumentRebase = false;
      return;
    }

    const file = this.getActiveMarkdownFile();
    if (!file || normalizePath(file.path) !== this.activeNotePath) {
      return;
    }

    const timestamp = new Date().toISOString();
    const conflictedSuggestions = this.rebasePendingSuggestionsFromEditorChanges(
      update.changes,
      timestamp
    );

    this.currentReviewState.currentHash = sha256(update.state.doc.toString());
    this.currentReviewState.updatedAt = timestamp;
    this.schedulePersistReviewState();
    this.refreshActiveEditorDecorations();

    if (conflictedSuggestions.length > 0) {
      new Notice(
        `Edited note text remapped suggestions. ${conflictedSuggestions.length} overlapping suggestion(s) marked conflict.`
      );
    }
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

  private async importCodexResponsesForActiveFile(): Promise<void> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      return;
    }

    const notePath = normalizePath(file.path);
    const state = await this.ensureReviewStateForNote(notePath, sha256(await this.app.vault.cachedRead(file)));
    const responseFiles = await this.persistence.listSelectionResponses();
    let importedCount = 0;

    for (const responseFile of responseFiles) {
      let response: CodexSelectionResponse;
      try {
        response = parseCodexSelectionResponse(
          await this.persistence.readSelectionResponse(responseFile)
        );
      } catch {
        continue;
      }

      if (normalizePath(response.notePath) !== notePath) {
        continue;
      }

      const imported = await this.applyCodexResponse(state, response, responseFile);
      if (imported) {
        importedCount += 1;
      }
    }

    if (importedCount > 0) {
      this.refreshActiveEditorDecorations();
      new Notice(`Imported ${importedCount} Codex response${importedCount === 1 ? "" : "s"}.`);
    }
  }

  private async applyCodexResponse(
    state: ReviewState,
    response: CodexSelectionResponse,
    responseFile: string
  ): Promise<boolean> {
    if (!this.activeNotePath) {
      return false;
    }

    const placeholder = state.suggestions.find(
      (suggestion) => suggestion.requestId === response.requestId
    );
    if (!placeholder) {
      return false;
    }

    const noteFile = this.getActiveMarkdownFile();
    if (!noteFile) {
      return false;
    }
    const noteText = await this.app.vault.cachedRead(noteFile);
    const currentHash = sha256(noteText);
    const now = new Date().toISOString();

    placeholder.rationale = response.suggestion.rationale;
    placeholder.newText = normalizeAiOutput(response.suggestion.newText);

    if (!placeholder.newText) {
      await this.persistence.deleteFile(responseFile);
      return false;
    }

    const currentTarget = noteText.slice(placeholder.start, placeholder.end);
    if (placeholder.status === "requested") {
      if (currentTarget === placeholder.expectedOldText && currentHash === response.baseHash) {
        placeholder.status = "pending";
        placeholder.decidedAt = undefined;
        placeholder.decidedBy = undefined;
      } else {
        placeholder.status = "conflict";
        placeholder.decidedAt = now;
        placeholder.decidedBy = this.settings.reviewerName || undefined;
      }
    }

    state.currentHash = currentHash;
    state.updatedAt = now;
    this.selectedSuggestionId = placeholder.status === "pending" ? placeholder.id : this.selectedSuggestionId;
    const reviewFile = await this.persistence.writeReviewState(state);
    await this.persistence.appendAuditEvent({
      eventType: "generate",
      notePath: this.activeNotePath,
      reviewFile,
      timestamp: now,
      reviewer: this.settings.reviewerName || undefined,
      suggestionId: placeholder.id,
      fromStatus: "requested",
      toStatus: placeholder.status,
      baseHash: state.baseHash,
      currentHash: state.currentHash,
      payloadGenerator: response.generator.model || response.generator.source
    });
    await this.persistence.deleteFile(responseFile);
    this.jumpToSuggestion(placeholder);
    return true;
  }

  private async replaceOverlappingSuggestions(
    state: ReviewState,
    start: number,
    end: number,
    timestamp: string
  ): Promise<number> {
    if (!this.activeNotePath) {
      return 0;
    }

    const overlapping = state.suggestions.filter((suggestion) => {
      if (
        suggestion.status !== "requested" &&
        suggestion.status !== "pending" &&
        suggestion.status !== "conflict"
      ) {
        return false;
      }
      return rangesOverlap(suggestion.start, suggestion.end, start, end);
    });

    if (overlapping.length === 0) {
      return 0;
    }

    const reviewFile = await this.persistence.writeReviewState(state);
    for (const suggestion of overlapping) {
      const fromStatus = suggestion.status;
      suggestion.status = "rejected";
      suggestion.decidedAt = timestamp;
      suggestion.decidedBy = this.settings.reviewerName || undefined;
      await this.persistence.appendAuditEvent({
        eventType: "reject",
        notePath: this.activeNotePath,
        reviewFile,
        timestamp,
        reviewer: this.settings.reviewerName || undefined,
        suggestionId: suggestion.id,
        fromStatus,
        toStatus: "rejected",
        baseHash: state.baseHash,
        currentHash: state.currentHash
      });
    }

    return overlapping.length;
  }

  private async maybeLaunchCodexWatcherForFile(file: TFile): Promise<void> {
    if (!this.settings.autoLaunchCodex) {
      return;
    }
    if (typeof window.require !== "function") {
      return;
    }
    if (process.platform !== "win32") {
      return;
    }

    const noteFolder = this.getAbsoluteNoteFolder(file);
    if (!noteFolder) {
      return;
    }
    const normalizedFolder = nodePath.normalize(noteFolder);
    if (this.isWatcherRunningForFolder(normalizedFolder)) {
      return;
    }

    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) {
      return;
    }

    const resolvedCodexCommand = this.resolveCodexCliCommand();
    if (!resolvedCodexCommand) {
      new Notice("AI Review could not find a Codex CLI executable. Set an explicit Codex CLI command in plugin settings.");
      return;
    }

    const watcherScriptPath = await this.persistence.writeWatcherScript(buildCodexWatcherScript());
    const responseSchemaPath = await this.persistence.writeResponseSchema(
      JSON.stringify(buildCodexResponseJsonSchema(), null, 2)
    );
    const absoluteWatcherScriptPath = nodePath.join(vaultBase, watcherScriptPath);
    const absoluteRequestsPath = nodePath.join(vaultBase, this.settings.requestsFolder);
    const absoluteResponsesPath = nodePath.join(vaultBase, this.settings.responsesFolder);
    const absoluteSchemaPath = nodePath.join(vaultBase, responseSchemaPath);

    try {
      const childProcess = window.require("child_process") as {
        spawn: (
          command: string,
          args: string[],
          options?: { detached?: boolean; stdio?: string; windowsHide?: boolean }
        ) => { unref?: () => void; pid?: number };
      };
      const child = childProcess.spawn(
        "cmd.exe",
        [
          "/c",
          "start",
          "",
          "/D",
          normalizedFolder,
          "powershell.exe",
          "-NoExit",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          absoluteWatcherScriptPath,
          "-VaultBasePath",
          vaultBase,
          "-NoteFolder",
          normalizedFolder,
          "-RequestsFolder",
          absoluteRequestsPath,
          "-ResponsesFolder",
          absoluteResponsesPath,
          "-ResponseSchemaPath",
          absoluteSchemaPath,
          "-CodexCommand",
          resolvedCodexCommand
        ],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }
      );
      child.unref?.();
      if (typeof child.pid === "number" && child.pid > 0) {
        this.launchedWatcherPids.set(normalizedFolder, child.pid);
      }
    } catch (error) {
      console.error("AI Review could not launch Codex terminal.", error);
      new Notice("AI Review could not auto-launch the Codex watcher. Check the Codex CLI command in settings.");
    }
  }

  private isWatcherRunningForFolder(folderPath: string): boolean {
    const pid = this.launchedWatcherPids.get(folderPath);
    if (!pid) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      this.launchedWatcherPids.delete(folderPath);
      return false;
    }
  }

  private resolveCodexCliCommand(): string | null {
    const configured = this.settings.codexCliCommand.trim();
    const fs = window.require?.("fs") as { existsSync?: (path: string) => boolean } | undefined;
    const existsSync = fs?.existsSync;
    const candidates = [
      configured,
      configured ? `${configured}.cmd` : "",
      configured ? `${configured}.ps1` : "",
      process.env.APPDATA
        ? nodePath.join(process.env.APPDATA, "npm", "codex.cmd")
        : "",
      process.env.APPDATA
        ? nodePath.join(process.env.APPDATA, "npm", "codex.ps1")
        : "",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.409.1734.0_x64__2p2nqsd0c76g0\\app\\resources\\codex.exe",
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.409.1734.0_x64__2p2nqsd0c76g0\\app\\resources\\codex"
    ].filter((value) => Boolean(value));

    if (!existsSync) {
      return configured || null;
    }

    for (const candidate of candidates) {
      if (nodePath.isAbsolute(candidate) && existsSync(candidate)) {
        return candidate;
      }
    }

    return configured || null;
  }

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string; basePath?: string };
    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    if (typeof adapter.basePath === "string" && adapter.basePath.trim()) {
      return adapter.basePath;
    }
    return null;
  }

  private getAbsoluteNoteFolder(file: TFile): string | null {
    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) {
      return null;
    }

    const relativeDir = nodePath.dirname(file.path);
    if (!relativeDir || relativeDir === ".") {
      return vaultBase;
    }
    return nodePath.join(vaultBase, relativeDir);
  }

  private getAbsoluteNotePath(file: TFile): string | null {
    const vaultBase = this.getVaultBasePath();
    if (!vaultBase) {
      return null;
    }
    return nodePath.join(vaultBase, file.path);
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

    this.suppressNextDocumentRebase = true;
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
      this.suppressNextDocumentRebase = true;
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
      if (
        suggestion.id === accepted.id ||
        (suggestion.status !== "pending" && suggestion.status !== "requested")
      ) {
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

  private rebasePendingSuggestionsFromEditorChanges(
    changes: ChangeDesc,
    timestamp: string
  ): Suggestion[] {
    if (!this.currentReviewState) {
      return [];
    }

    const conflicts: Suggestion[] = [];
    for (const suggestion of this.currentReviewState.suggestions) {
      if (suggestion.status !== "pending" && suggestion.status !== "requested") {
        continue;
      }

      if (doesChangeOverlapSuggestion(changes, suggestion)) {
        const overlapRange = findOverlappingChangedRange(changes, suggestion);
        const mappedStart = changes.mapPos(suggestion.start, 1, MapMode.Simple);
        const mappedEnd = changes.mapPos(suggestion.end, -1, MapMode.Simple);
        if (
          mappedStart !== null &&
          mappedEnd !== null &&
          mappedEnd >= mappedStart
        ) {
          suggestion.start = mappedStart;
          suggestion.end = mappedEnd;
        } else if (overlapRange) {
          suggestion.start = overlapRange.fromB;
          suggestion.end = overlapRange.toB;
        }
        suggestion.status = "conflict";
        suggestion.decidedAt = timestamp;
        suggestion.decidedBy = this.settings.reviewerName || undefined;
        conflicts.push(suggestion);
        continue;
      }

      if (suggestion.start === suggestion.end) {
        const mapped = changes.mapPos(suggestion.start, 1, MapMode.Simple);
        if (mapped === null) {
          suggestion.status = "conflict";
          suggestion.decidedAt = timestamp;
          suggestion.decidedBy = this.settings.reviewerName || undefined;
          conflicts.push(suggestion);
          continue;
        }
        suggestion.start = mapped;
        suggestion.end = mapped;
        continue;
      }

      const mappedStart = changes.mapPos(suggestion.start, 1, MapMode.TrackBefore);
      const mappedEnd = changes.mapPos(suggestion.end, -1, MapMode.TrackAfter);
      if (mappedStart === null || mappedEnd === null || mappedEnd < mappedStart) {
        suggestion.status = "conflict";
        suggestion.decidedAt = timestamp;
        suggestion.decidedBy = this.settings.reviewerName || undefined;
        conflicts.push(suggestion);
        continue;
      }

      suggestion.start = mappedStart;
      suggestion.end = mappedEnd;
    }

    return conflicts;
  }

  private schedulePersistReviewState(): void {
    if (!this.currentReviewState) {
      return;
    }
    if (this.persistReviewStateTimer !== null) {
      window.clearTimeout(this.persistReviewStateTimer);
    }

    this.persistReviewStateTimer = window.setTimeout(() => {
      if (!this.currentReviewState) {
        return;
      }
      void this.persistence.writeReviewState(this.currentReviewState);
      this.persistReviewStateTimer = null;
    }, 250);
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

function normalizeAiOutput(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function buildCodexResponseTemplate(request: CodexSelectionRequest): CodexSelectionResponse {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    notePath: request.notePath,
    baseHash: request.baseHash,
    generator: {
      source: "codex",
      model: "",
      generatedAt: ""
    },
    suggestion: {
      newText: "",
      rationale: ""
    }
  };
}

function buildCodexLaunchGuide(
  request: CodexSelectionRequest,
  requestFile: string,
  responseFile: string,
  responseTemplateFile: string,
  absoluteNotePath: string | null
): string {
  return [
    "# AI Review Codex Launch Guide",
    "",
    "You were launched by the Obsidian AI Review plugin.",
    "",
    "## Task",
    "- Read the full note first so you have whole-document context before suggesting an edit.",
    "- Read the request JSON.",
    "- Work with the user interactively in this terminal if they want to refine the edit.",
    "- When ready, write the final response JSON to the exact response path below.",
    "- The plugin will import that response automatically.",
    "",
    "## Files",
    `- Request JSON: ${requestFile}`,
    `- Response JSON to write: ${responseFile}`,
    `- Response template JSON: ${responseTemplateFile}`,
    `- Full note path: ${absoluteNotePath ?? request.notePath}`,
    "",
    "## Request Summary",
    `- Request ID: ${request.requestId}`,
    `- Note path: ${request.notePath}`,
    `- Base hash: ${request.baseHash}`,
    `- Instruction: ${request.instruction}`,
    "",
    "### Selected text",
    "```text",
    request.selection.text || "",
    "```",
    "",
    "### Context before",
    "```text",
    request.contextBefore || "[none]",
    "```",
    "",
    "### Context after",
    "```text",
    request.contextAfter || "[none]",
    "```",
    "",
    "## Required response schema",
    "```json",
    JSON.stringify(buildCodexResponseTemplate(request), null, 2),
    "```",
    "",
    "## Rules",
    "- Return only one replacement suggestion per request.",
    "- Preserve citation markers, equations, units, markdown, and claim scope unless the user explicitly wants more aggressive edits.",
    "- Fill `generator.model` and `generator.generatedAt` before writing the final response JSON.",
    "- Fill `suggestion.newText` with the replacement text only.",
    "- `suggestion.rationale` is optional but recommended and should stay short."
  ].join("\n");
}

function buildCodexResponseJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "requestId", "notePath", "baseHash", "generator", "suggestion"],
    properties: {
      schemaVersion: { type: "integer", const: 1 },
      requestId: { type: "string" },
      notePath: { type: "string" },
      baseHash: { type: "string" },
      generator: {
        type: "object",
        additionalProperties: false,
        required: ["source", "model", "generatedAt"],
        properties: {
          source: { type: "string", const: "codex" },
          model: { type: "string" },
          generatedAt: { type: "string" }
        }
      },
      suggestion: {
        type: "object",
        additionalProperties: false,
        required: ["newText"],
        properties: {
          newText: { type: "string" },
          rationale: { type: "string" }
        }
      }
    }
  };
}

function buildCodexWatcherScript(): string {
  return [
    "param(",
    "  [Parameter(Mandatory=$true)][string]$VaultBasePath,",
    "  [Parameter(Mandatory=$true)][string]$NoteFolder,",
    "  [Parameter(Mandatory=$true)][string]$RequestsFolder,",
    "  [Parameter(Mandatory=$true)][string]$ResponsesFolder,",
    "  [Parameter(Mandatory=$true)][string]$ResponseSchemaPath,",
    "  [Parameter(Mandatory=$true)][string]$CodexCommand",
    ")",
    "",
    "$ErrorActionPreference = 'Continue'",
    "",
    "function Log([string]$Message) {",
    "  Write-Host \"[AI Review Watcher] $Message\"",
    "}",
    "",
    "function Normalize([string]$PathValue) {",
    "  try {",
    "    return [System.IO.Path]::GetFullPath($PathValue)",
    "  } catch {",
    "    return $PathValue",
    "  }",
    "}",
    "",
    "function Get-RequestIdFromPath([string]$PathValue) {",
    "  return [System.IO.Path]::GetFileName($PathValue) -replace '\\.request\\.json$', ''",
    "}",
    "",
    "function Clean-JsonText([string]$RawText) {",
    "  if (-not $RawText) {",
    "    return ''",
    "  }",
    "  $trimmed = $RawText.Trim()",
    "  if ($trimmed.StartsWith('```')) {",
    "    $trimmed = [regex]::Replace($trimmed, '^```(?:json)?\\s*', '')",
    "    $trimmed = [regex]::Replace($trimmed, '\\s*```$', '')",
    "  }",
    "  return $trimmed.Trim()",
    "}",
    "",
    "function Invoke-Request([string]$RequestPath) {",
    "  $requestId = Get-RequestIdFromPath $RequestPath",
    "  $lockPath = Join-Path $RequestsFolder \"$requestId.processing.lock\"",
    "  $donePath = Join-Path $RequestsFolder \"$requestId.done\"",
    "  $responsePath = Join-Path $ResponsesFolder \"$requestId.response.json\"",
    "  $templatePath = Join-Path $ResponsesFolder \"$requestId.response.template.json\"",
    "  $guidePath = Join-Path $RequestsFolder \"$requestId.launch.md\"",
    "  $tempOutputPath = Join-Path $ResponsesFolder \"$requestId.codex-output.json\"",
    "  $runLogPath = Join-Path $ResponsesFolder \"$requestId.codex.log\"",
    "  $errorPath = Join-Path $ResponsesFolder \"$requestId.error.log\"",
    "",
    "  if ((Test-Path $donePath) -or (Test-Path $responsePath) -or (Test-Path $lockPath)) {",
    "    return",
    "  }",
    "",
    "  try {",
    "    $requestRaw = Get-Content -LiteralPath $RequestPath -Raw",
    "    $request = $requestRaw | ConvertFrom-Json",
    "  } catch {",
    "    Log \"Skipping unreadable request: $RequestPath\"",
    "    return",
    "  }",
    "",
    "  $notePath = Join-Path $VaultBasePath $request.notePath",
    "  $requestNoteFolder = Split-Path -Parent $notePath",
    "  if ((Normalize $requestNoteFolder) -ne (Normalize $NoteFolder)) {",
    "    return",
    "  }",
    "",
    "  New-Item -ItemType File -Path $lockPath -Force | Out-Null",
    "  try {",
    "    Log \"Processing $requestId\"",
    "    $prompt = @\"",
    "Process one Obsidian AI Review request.",
    "",
    "Read these files first:",
    "- Request JSON: $RequestPath",
    "- Full note markdown: $notePath",
    "- Launch guide: $guidePath",
    "- Response template: $templatePath",
    "",
    "Requirements:",
    "- Read the full note before drafting the replacement.",
    "- Produce exactly one JSON object that matches the response schema.",
    "- Return raw JSON only. No markdown fences. No commentary.",
    "- Preserve citation markers, equations, units, markdown, and claim scope unless the request itself implies a change.",
    "\"@",
    "",
    "    & $CodexCommand exec -C $NoteFolder --skip-git-repo-check --disable plugins --ephemeral --color never --output-schema $ResponseSchemaPath -o $tempOutputPath $prompt *> $runLogPath",
    "    $codexExitCode = $LASTEXITCODE",
    "    if ($codexExitCode -ne 0 -and -not (Test-Path $tempOutputPath)) {",
    "      throw \"Codex exited with code $codexExitCode. See $runLogPath\"",
    "    }",
    "",
    "    if (-not (Test-Path $tempOutputPath)) {",
    "      throw \"Codex did not write an output file.\"",
    "    }",
    "",
    "    $rawOutput = Get-Content -LiteralPath $tempOutputPath -Raw",
    "    $jsonText = Clean-JsonText $rawOutput",
    "    $parsed = $jsonText | ConvertFrom-Json",
    "",
    "    if (-not $parsed.generator.generatedAt) {",
    "      $parsed.generator.generatedAt = (Get-Date).ToString(\"o\")",
    "    }",
    "    if (-not $parsed.generator.source) {",
    "      $parsed.generator.source = 'codex'",
    "    }",
    "    if (-not $parsed.generator.model) {",
    "      $parsed.generator.model = 'codex'",
    "    }",
    "",
    "    $parsed | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $responsePath -Encoding UTF8",
    "    New-Item -ItemType File -Path $donePath -Force | Out-Null",
    "    if (Test-Path $errorPath) {",
    "      Remove-Item -LiteralPath $errorPath -Force",
    "    }",
    "    Log \"Wrote response for $requestId\"",
    "  } catch {",
    "    (($_ | Out-String) + \"`n`nRun log: $runLogPath\") | Set-Content -LiteralPath $errorPath -Encoding UTF8",
    "    Log \"Failed $requestId. See $errorPath\"",
    "  } finally {",
    "    if (Test-Path $tempOutputPath) {",
    "      Remove-Item -LiteralPath $tempOutputPath -Force",
    "    }",
    "    if (Test-Path $lockPath) {",
    "      Remove-Item -LiteralPath $lockPath -Force",
    "    }",
    "  }",
    "}",
    "",
    "Log \"Watching requests in $RequestsFolder for note folder $NoteFolder\"",
    "while ($true) {",
    "  try {",
    "    if (-not (Test-Path $RequestsFolder)) {",
    "      Start-Sleep -Seconds 2",
    "      continue",
    "    }",
    "    Get-ChildItem -LiteralPath $RequestsFolder -Filter *.request.json -File -ErrorAction SilentlyContinue |",
    "      Sort-Object LastWriteTime, Name |",
    "      ForEach-Object {",
    "        Invoke-Request $_.FullName",
    "      }",
    "  } catch {",
    "    Log (\"Watcher loop error: \" + ($_ | Out-String))",
    "  }",
    "  Start-Sleep -Seconds 2",
    "}"
  ].join("\n");
}

function parseCodexSelectionResponse(raw: unknown): CodexSelectionResponse {
  if (!isObject(raw)) {
    throw new Error("Response must be an object.");
  }
  if (raw.schemaVersion !== 1) {
    throw new Error("Unsupported response schemaVersion.");
  }
  if (typeof raw.requestId !== "string" || !raw.requestId.trim()) {
    throw new Error("Response requestId is required.");
  }
  if (typeof raw.notePath !== "string" || !raw.notePath.trim()) {
    throw new Error("Response notePath is required.");
  }
  if (typeof raw.baseHash !== "string" || !raw.baseHash.trim()) {
    throw new Error("Response baseHash is required.");
  }
  if (!isObject(raw.generator) || raw.generator.source !== "codex") {
    throw new Error("Response generator.source must be codex.");
  }
  if (typeof raw.generator.generatedAt !== "string" || !raw.generator.generatedAt.trim()) {
    throw new Error("Response generator.generatedAt is required.");
  }
  if (!isObject(raw.suggestion) || typeof raw.suggestion.newText !== "string") {
    throw new Error("Response suggestion.newText is required.");
  }

  return {
    schemaVersion: 1,
    requestId: raw.requestId,
    notePath: raw.notePath,
    baseHash: raw.baseHash,
    generator: {
      source: "codex",
      model: typeof raw.generator.model === "string" ? raw.generator.model : undefined,
      generatedAt: raw.generator.generatedAt
    },
    suggestion: {
      newText: raw.suggestion.newText,
      rationale: typeof raw.suggestion.rationale === "string" ? raw.suggestion.rationale : undefined
    }
  };
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

function doesChangeOverlapSuggestion(changes: ChangeDesc, suggestion: Suggestion): boolean {
  let overlaps = false;

  changes.iterChangedRanges((fromA, toA) => {
    if (overlaps) {
      return;
    }

    if (fromA === toA) {
      if (suggestion.start < fromA && fromA < suggestion.end) {
        overlaps = true;
      }
      return;
    }

    if (suggestion.start < toA && fromA < suggestion.end) {
      overlaps = true;
    }
  });

  return overlaps;
}

function findOverlappingChangedRange(
  changes: ChangeDesc,
  suggestion: Suggestion
): { fromB: number; toB: number } | null {
  let overlap: { fromB: number; toB: number } | null = null;

  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (overlap) {
      return;
    }

    if (fromA === toA) {
      if (suggestion.start < fromA && fromA < suggestion.end) {
        overlap = { fromB, toB };
      }
      return;
    }

    if (suggestion.start < toA && fromA < suggestion.end) {
      overlap = { fromB, toB };
    }
  });

  return overlap;
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  if (aStart === aEnd && bStart === bEnd) {
    return aStart === bStart;
  }
  if (aStart === aEnd) {
    return bStart <= aStart && aStart <= bEnd;
  }
  if (bStart === bEnd) {
    return aStart <= bStart && bStart <= aEnd;
  }
  return aStart < bEnd && bStart < aEnd;
}
