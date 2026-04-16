import { App, PluginSettingTab, Setting } from "obsidian";
import type AiReviewPlugin from "./main";

export class AiReviewSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: AiReviewPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "AI Review Settings" });

    new Setting(containerEl)
      .setName("Reviewer name")
      .setDesc("Included in audit log records for accept/reject actions.")
      .addText((text) =>
        text
          .setPlaceholder("Optional")
          .setValue(this.plugin.settings.reviewerName)
          .onChange(async (value) => {
            this.plugin.settings.reviewerName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Review sidecar folder")
      .setDesc("Vault-relative folder for review state JSON files.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/ai-review")
          .setValue(this.plugin.settings.reviewsFolder)
          .onChange(async (value) => {
            this.plugin.settings.reviewsFolder = value.trim() || ".obsidian/ai-review";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Audit log path")
      .setDesc("Vault-relative NDJSON file for append-only audit events.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/ai-review/review-log.ndjson")
          .setValue(this.plugin.settings.auditLogPath)
          .onChange(async (value) => {
            this.plugin.settings.auditLogPath =
              value.trim() || ".obsidian/ai-review/review-log.ndjson";
            await this.plugin.saveSettings();
          })
      );
  }
}

