import { StateEffect } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { ReviewStatus, Suggestion } from "./types";

export type SuggestionAction = "accept" | "reject";

export interface ReviewDecorationHost {
  getRenderableSuggestions(): Suggestion[];
  onSuggestionAction(id: string, action: SuggestionAction): Promise<void> | void;
}

export const refreshReviewEffect = StateEffect.define<void>();

export function createReviewDecorationsExtension(host: ReviewDecorationHost) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorationSet(view, host);
      }

      update(update: ViewUpdate): void {
        const hasRefreshEffect = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshReviewEffect))
        );
        if (update.docChanged || update.viewportChanged || hasRefreshEffect) {
          this.decorations = buildDecorationSet(update.view, host);
        }
      }
    },
    {
      decorations: (value) => value.decorations
    }
  );
}

function buildDecorationSet(view: EditorView, host: ReviewDecorationHost): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const suggestions = host.getRenderableSuggestions();
  const docLength = view.state.doc.length;

  for (const suggestion of suggestions) {
    const start = clampOffset(suggestion.start, docLength);
    const end = clampOffset(suggestion.end, docLength);
    const statusClass = statusToClass(suggestion.status);
    const isInsertion = start === end;

    if (!isInsertion) {
      builder.add(start, end, Decoration.mark({ class: `ai-review-delete-mark ${statusClass}` }));
    }

    const controlWidget = new SuggestionControlsWidget(suggestion, host);
    builder.add(end, end, Decoration.widget({ widget: controlWidget, side: 1 }));
  }

  return builder.finish();
}

function clampOffset(offset: number, docLength: number): number {
  if (offset < 0) {
    return 0;
  }
  if (offset > docLength) {
    return docLength;
  }
  return offset;
}

function statusToClass(status: ReviewStatus): string {
  if (status === "stale") {
    return "ai-review-status-stale";
  }
  if (status === "conflict") {
    return "ai-review-status-conflict";
  }
  if (status === "accepted") {
    return "ai-review-status-accepted";
  }
  if (status === "rejected") {
    return "ai-review-status-rejected";
  }
  return "ai-review-status-pending";
}

class SuggestionControlsWidget extends WidgetType {
  constructor(
    private readonly suggestion: Suggestion,
    private readonly host: ReviewDecorationHost
  ) {
    super();
  }

  override eq(other: SuggestionControlsWidget): boolean {
    return (
      other.suggestion.id === this.suggestion.id &&
      other.suggestion.status === this.suggestion.status &&
      other.suggestion.newText === this.suggestion.newText
    );
  }

  override toDOM(): HTMLElement {
    const container = document.createElement("span");
    container.className = "ai-review-inline-controls";

    if (this.suggestion.newText.length > 0) {
      const insertionPreview = document.createElement("span");
      insertionPreview.className = "ai-review-insert-preview";
      insertionPreview.textContent = `+ ${truncateText(this.suggestion.newText, 60)}`;
      container.appendChild(insertionPreview);
    }

    const statusLabel = document.createElement("span");
    statusLabel.className = "ai-review-status-pill";
    statusLabel.textContent = this.suggestion.status;
    container.appendChild(statusLabel);

    const isPending = this.suggestion.status === "pending";
    const acceptButton = document.createElement("button");
    acceptButton.textContent = "Accept";
    acceptButton.disabled = !isPending;
    acceptButton.className = "ai-review-accept-button";
    acceptButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.host.onSuggestionAction(this.suggestion.id, "accept");
    };

    const rejectButton = document.createElement("button");
    rejectButton.textContent = "Reject";
    rejectButton.disabled = !isPending;
    rejectButton.className = "ai-review-reject-button";
    rejectButton.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.host.onSuggestionAction(this.suggestion.id, "reject");
    };

    container.appendChild(acceptButton);
    container.appendChild(rejectButton);

    return container;
  }
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}...`;
}

