import { Notice, Plugin } from "obsidian";
import { ReviewPersistence } from "./persistence";
import { DEFAULT_SETTINGS, type AiReviewSettings } from "./types";

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
  }

  private async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<AiReviewSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
