import { App, normalizePath } from "obsidian";
import { sha256 } from "./hash";
import type {
  AiReviewSettings,
  AuditEvent,
  CodexSelectionRequest,
  CodexSelectionResponse,
  ReviewState
} from "./types";

export class ReviewPersistence {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => AiReviewSettings
  ) {}

  getReviewFilePath(notePath: string): string {
    const noteHash = sha256(normalizePath(notePath));
    return this.getArtifactPath(this.getSettings().reviewsFolder, `${noteHash}.review.json`);
  }

  getRequestFilePath(requestId: string): string {
    return this.getArtifactPath(this.getSettings().requestsFolder, `${requestId}.request.json`);
  }

  getResponseFilePath(requestId: string): string {
    return this.getArtifactPath(this.getSettings().responsesFolder, `${requestId}.response.json`);
  }

  getResponseTemplateFilePath(requestId: string): string {
    return this.getArtifactPath(
      this.getSettings().responsesFolder,
      `${requestId}.response.template.json`
    );
  }

  getLaunchGuideFilePath(requestId: string): string {
    return this.getArtifactPath(this.getSettings().requestsFolder, `${requestId}.launch.md`);
  }

  getWatcherScriptPath(): string {
    return this.getArtifactPath(this.getSettings().reviewsFolder, "watch-review-inbox.ps1");
  }

  getResponseSchemaPath(): string {
    return this.getArtifactPath(this.getSettings().reviewsFolder, "codex-response-schema.json");
  }

  async readReviewState(notePath: string): Promise<ReviewState | null> {
    const reviewPath = this.getReviewFilePath(notePath);
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(reviewPath))) {
      return null;
    }

    const raw = await adapter.read(reviewPath);
    return JSON.parse(stripJsonBom(raw)) as ReviewState;
  }

  async writeReviewState(state: ReviewState): Promise<string> {
    const reviewPath = this.getReviewFilePath(state.notePath);
    return this.writeJsonFile(reviewPath, state);
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

  async writeSelectionRequest(request: CodexSelectionRequest): Promise<string> {
    return this.writeJsonFile(this.getRequestFilePath(request.requestId), request);
  }

  async writeResponseTemplate(requestId: string, template: unknown): Promise<string> {
    return this.writeJsonFile(this.getResponseTemplateFilePath(requestId), template);
  }

  async writeLaunchGuide(requestId: string, content: string): Promise<string> {
    return this.writeTextFile(this.getLaunchGuideFilePath(requestId), content);
  }

  async writeWatcherScript(content: string): Promise<string> {
    return this.writeTextFile(this.getWatcherScriptPath(), content);
  }

  async writeResponseSchema(content: string): Promise<string> {
    return this.writeTextFile(this.getResponseSchemaPath(), content);
  }

  async listSelectionResponses(): Promise<string[]> {
    const folderPath = normalizePath(this.getSettings().responsesFolder);
    await this.ensureFolder(folderPath);
    const listed = await this.app.vault.adapter.list(folderPath);
    return listed.files
      .map((path) => normalizePath(path))
      .filter((path) => path.endsWith(".response.json"));
  }

  async readSelectionResponse(path: string): Promise<CodexSelectionResponse> {
    const raw = await this.app.vault.adapter.read(path);
    return JSON.parse(stripJsonBom(raw)) as CodexSelectionResponse;
  }

  async deleteFile(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(path)) {
      await adapter.remove(path);
    }
  }

  private getArtifactPath(folderPath: string, fileName: string): string {
    return normalizePath(`${normalizePath(folderPath)}/${fileName}`);
  }

  private async writeJsonFile(path: string, value: unknown): Promise<string> {
    await this.ensureParentFolder(path);
    await this.app.vault.adapter.write(path, JSON.stringify(value, null, 2));
    return path;
  }

  private async writeTextFile(path: string, content: string): Promise<string> {
    await this.ensureParentFolder(path);
    await this.app.vault.adapter.write(path, content);
    return path;
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

function stripJsonBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
