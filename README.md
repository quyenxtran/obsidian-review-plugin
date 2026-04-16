# AI Review Plugin for Obsidian

DOCX-style review workflow for AI edits in markdown notes:
- import AI suggestions from JSON
- review inline insert/delete markers
- accept/reject per suggestion
- navigate suggestions with commands
- keep an append-only audit log

## Scope (v1)
- Desktop Obsidian only
- Single active note review at a time
- Import-only backend (generate JSON in Codex or another tool, then import)

## Commands
- `AI Review: Show status`
- `AI Review: Import suggestions from JSON`
- `AI Review: Next suggestion`
- `AI Review: Previous suggestion`
- `AI Review: Accept current suggestion`
- `AI Review: Reject current suggestion`
- `AI Review: Accept all pending`
- `AI Review: Reject all pending`

## Data Files
- Review state sidecars:
  - `.obsidian/ai-review/<sha256(notePath)>.review.json`
- Audit log (append-only NDJSON):
  - `.obsidian/ai-review/review-log.ndjson`

Both paths are configurable in plugin settings.

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
- "Payload is for X, active note is Y":
  - open the matching note and re-run import.
- "Marked stale (hash mismatch)":
  - note text changed since suggestions were generated; regenerate suggestions from latest note text.
- "Conflict for s-N":
  - expected anchor text no longer matches; regenerate that suggestion against current content.

## Limitations
- No mobile support in v1.
- No direct model API calls from plugin in v1.
- Offsets are UTF-16 character offsets and must match Obsidian editor text.

