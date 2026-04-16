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
      .setName("OpenAI API key")
      .setDesc("Stored in this plugin's local settings file and used for direct AI review generation.")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.openAiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.openAiApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        return text;
      });

    new Setting(containerEl)
      .setName("OpenAI Responses endpoint")
      .setDesc("Override only if you are using a compatible gateway.")
      .addText((text) =>
        text
          .setPlaceholder("https://api.openai.com/v1/responses")
          .setValue(this.plugin.settings.openAiEndpoint)
          .onChange(async (value) => {
            this.plugin.settings.openAiEndpoint =
              value.trim() || "https://api.openai.com/v1/responses";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OpenAI model")
      .setDesc("Model used to generate selection-level rewrite suggestions.")
      .addText((text) =>
        text
          .setPlaceholder("gpt-5.4-mini")
          .setValue(this.plugin.settings.openAiModel)
          .onChange(async (value) => {
            this.plugin.settings.openAiModel = value.trim() || "gpt-5.4-mini";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default AI edit instruction")
      .setDesc("Used when you run the selection-based AI review command.")
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
