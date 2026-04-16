import { App, normalizePath } from "obsidian";
import { sha256 } from "./hash";
import type { AiReviewSettings, AuditEvent, ReviewState } from "./types";

export class ReviewPersistence {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => AiReviewSettings
  ) {}

  getReviewFilePath(notePath: string): string {
    const settings = this.getSettings();
    const noteHash = sha256(normalizePath(notePath));
    const fileName = `${noteHash}.review.json`;
    return normalizePath(`${settings.reviewsFolder}/${fileName}`);
  }

  async readReviewState(notePath: string): Promise<ReviewState | null> {
    const reviewPath = this.getReviewFilePath(notePath);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(reviewPath))) {
      return null;
    }

    const raw = await adapter.read(reviewPath);
    return JSON.parse(raw) as ReviewState;
  }

  async writeReviewState(state: ReviewState): Promise<string> {
    const reviewPath = this.getReviewFilePath(state.notePath);
    await this.ensureParentFolder(reviewPath);
    await this.app.vault.adapter.write(reviewPath, JSON.stringify(state, null, 2));
    return reviewPath;
  }

  async appendAuditEvent(event: AuditEvent): Promise<void> {
    const settings = this.getSettings();
    const logPath = normalizePath(settings.auditLogPath);
    await this.ensureParentFolder(logPath);

    const adapter = this.app.vault.adapter;
    const line = `${JSON.stringify(event)}\n`;

    const adapterWithAppend = adapter as typeof adapter & {
      append?: (path: string, data: string) => Promise<void>;
    };
    if (typeof adapterWithAppend.append === "function") {
      await adapterWithAppend.append(logPath, line);
      return;
    }

    if (await adapter.exists(logPath)) {
      const previous = await adapter.read(logPath);
      await adapter.write(logPath, `${previous}${line}`);
      return;
    }

    await adapter.write(logPath, line);
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const idx = path.lastIndexOf("/");
    if (idx <= 0) {
      return;
    }
    await this.ensureFolder(path.slice(0, idx));
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath).replace(/\/+$/g, "");
    if (!normalized) {
      return;
    }

    const segments = normalized.split("/");
    const adapter = this.app.vault.adapter;
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (await adapter.exists(current)) {
        continue;
      }
      await adapter.mkdir(current);
    }
  }
}
