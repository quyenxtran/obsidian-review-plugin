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
      .setName("Default AI edit instruction")
      .setDesc("Written into exported selection requests for terminal Codex to follow.")
      .addTextArea((text) =>
        text
          .setPlaceholder("Revise the selected text...")
          .setValue(this.plugin.settings.defaultEditInstruction)
          .onChange(async (value) => {
            this.plugin.settings.defaultEditInstruction =
              value.trim() ||
              "Revise the selected text for clarity, grammar, technical precision, and concision. Preserve meaning, markdown, citations, equations, and notation. Return only the revised replacement text with no commentary or quotation marks.";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-launch Codex")
      .setDesc("When enabled, opening a new request launches a Codex terminal in the note folder if this plugin has not launched one there yet.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoLaunchCodex)
          .onChange(async (value) => {
            this.plugin.settings.autoLaunchCodex = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Codex CLI command")
      .setDesc("Command used to start the terminal Codex session.")
      .addText((text) =>
        text
          .setPlaceholder("codex")
          .setValue(this.plugin.settings.codexCliCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexCliCommand = value.trim() || "codex";
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
      .setName("Request folder")
      .setDesc("Vault-relative folder where selection requests are written for terminal Codex.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/ai-review/requests")
          .setValue(this.plugin.settings.requestsFolder)
          .onChange(async (value) => {
            this.plugin.settings.requestsFolder =
              value.trim() || ".obsidian/ai-review/requests";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Response folder")
      .setDesc("Vault-relative folder where terminal Codex writes completed response JSON files.")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian/ai-review/responses")
          .setValue(this.plugin.settings.responsesFolder)
          .onChange(async (value) => {
            this.plugin.settings.responsesFolder =
              value.trim() || ".obsidian/ai-review/responses";
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
