import { Notice, Plugin } from "obsidian";

export default class AiReviewPlugin extends Plugin {
  override async onload(): Promise<void> {
    this.addCommand({
      id: "ai-review-status",
      name: "AI Review: Show status",
      callback: () => {
        new Notice("AI Review plugin loaded.");
      }
    });
  }
}
