# AI Review Plugin for Obsidian

DOCX-style review workflow for AI edits in markdown notes:
- request Codex suggestions from selected text via request/response JSON files
- review inline insert/delete markers
- accept/reject per suggestion
- navigate suggestions with commands
- keep an append-only audit log

## Scope (v1)
- Desktop Obsidian only
- Single active note review at a time
- Terminal-Codex workflow via request/response files
- Legacy JSON import still available for backfill and debugging

## Commands
- `AI Review: Show status`
- `AI Review: Request Codex suggestion for selection`
- `AI Review: Check for Codex responses`
- `AI Review: Import suggestions from JSON (legacy)`
- `AI Review: Next suggestion`
- `AI Review: Previous suggestion`
- `AI Review: Accept current suggestion`
- `AI Review: Reject current suggestion`
- `AI Review: Accept all pending`
- `AI Review: Reject all pending`

## Editor UI
- When text is selected in the editor, the right-click context menu includes `AI Review Selection`.
- That menu item uses the same request flow as the command palette entry.

## Data Files
- Review state sidecars:
  - `.obsidian/ai-review/<sha256(notePath)>.review.json`
- Selection requests:
  - `.obsidian/ai-review/requests/<requestId>.request.json`
- Launch guides for spawned Codex terminals:
  - `.obsidian/ai-review/requests/<requestId>.launch.md`
- Completed Codex responses:
  - `.obsidian/ai-review/responses/<requestId>.response.json`
- Response templates for Codex to fill:
  - `.obsidian/ai-review/responses/<requestId>.response.template.json`
- Audit log (append-only NDJSON):
  - `.obsidian/ai-review/review-log.ndjson`

Both paths are configurable in plugin settings.

## Terminal Codex Flow
1. In Obsidian, select text in a note.
2. Run `AI Review: Request Codex suggestion for selection`.
3. If auto-launch is enabled, the plugin opens a fresh Codex terminal in the same folder as the active markdown file for each new request.
4. The plugin writes a request JSON file into `.obsidian/ai-review/requests/`.
5. The plugin also writes a launch guide and a response template so the spawned Codex terminal has the exact schema and file targets available immediately.
6. In terminal Codex, read the guide, read the full note for context, then write a matching response JSON into `.obsidian/ai-review/responses/`.
7. The plugin polls for responses and converts them into inline pending suggestions automatically.
8. Accept, reject, or edit the inline suggestion in Obsidian.

## Auto-launch Notes
- Current implementation is Windows-first.
- The current implementation launches a fresh Codex terminal per request instead of trying to inject new prompts into an already-running interactive Codex session.
- You can disable this behavior in plugin settings.

## Request Schema (v1)

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "notePath": "Drafts/Main Essay.md",
  "baseHash": "sha256-of-note-text-at-request-time",
  "createdAt": "2026-04-16T12:00:00.000Z",
  "instruction": "Revise the selected text for clarity...",
  "contextBefore": "prior context",
  "contextAfter": "following context",
  "selection": {
    "start": 120,
    "end": 152,
    "text": "old phrase here"
  }
}
```

## Response Schema (v1)

```json
{
  "schemaVersion": 1,
  "requestId": "req-123",
  "notePath": "Drafts/Main Essay.md",
  "baseHash": "sha256-of-note-text-at-request-time",
  "generator": {
    "source": "codex",
    "model": "gpt-5.4",
    "generatedAt": "2026-04-16T12:01:00.000Z"
  },
  "suggestion": {
    "newText": "new phrase here",
    "rationale": "tighten wording"
  }
}
```

## JSON Import Schema (v1)

```json
{
  "schemaVersion": 1,
  "notePath": "Drafts/My Note.md",
  "baseHash": "sha256-of-note-text-at-generation-time",
  "generator": {
    "source": "codex",
    "model": "gpt-5.4",
    "generatedAt": "2026-04-16T12:00:00.000Z"
  },
  "suggestions": [
    {
      "id": "s-1",
      "start": 120,
      "end": 152,
      "expectedOldText": "old phrase here",
      "newText": "new phrase here",
      "rationale": "tighten wording",
      "createdAt": "2026-04-16T12:00:00.000Z"
    }
  ]
}
```

## How Accept/Reject Works
- `Reject` changes only the suggestion status.
- `Accept` applies edits to the note text.
- Apply checks `expectedOldText` at `[start, end]`.
- If text does not match, suggestion becomes `conflict` and is not applied.
- Batch apply (`Accept all pending`) uses deterministic descending offsets to avoid shift bugs.

## Build and Package
1. Install dependencies:
   - `npm install`
2. Typecheck:
   - `npm run check`
3. Build plugin bundle:
   - `npm run build`
4. For development watch mode:
   - `npm run dev`

Generated output: `main.js` in repo root.

## Troubleshooting
- "Created Codex request" but nothing appears inline:
  - make sure terminal Codex wrote a valid response JSON into the configured responses folder.
- Response imported as `conflict`:
  - the selected span changed before the response arrived; use `Resolve` or regenerate from the latest text.
- "Payload is for X, active note is Y":
  - open the matching note and re-run import.
- "Marked stale (hash mismatch)":
  - note text changed since suggestions were generated; regenerate suggestions from latest note text.
- "Conflict for s-N":
  - expected anchor text no longer matches; regenerate that suggestion against current content.

## Limitations
- No mobile support in v1.
- No direct model API calls in the primary workflow; generation is delegated to terminal Codex.
- Offsets are UTF-16 character offsets and must match Obsidian editor text.
