# Daily context briefing

The daily briefing produces a focused "here is what matters right now" view of your memory store by cross-referencing:

- **Active threads** — memories grouped by entity reference or topic, touched inside the lookback window.
- **Recent entities** — entities whose last-updated timestamp falls inside the window, ranked by the standard entity score (recency + frequency + activity + type priority + relationship density).
- **Open commitments** — memories tagged `pending`, memories in the `commitment` category, and memories whose content matches an unresolved question heuristic (`?`, `follow up`, `todo`).
- **Suggested follow-ups** — 0–10 short prompts generated via the OpenAI Responses API, only when `OPENAI_API_KEY` is available and `briefing.llmFollowups` is enabled.
- **Today's calendar** — rendered only when a calendar source is configured (see below).

## CLI

```bash
remnic briefing
remnic briefing --since 3d
remnic briefing --focus person:"Alex Ops"
remnic briefing --focus project:remnic-core
remnic briefing --focus topic:retrieval
remnic briefing --format json
remnic briefing --save
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--since <window>` | `yesterday` | Lookback window. Accepts `yesterday`, `today`, `NNh`, `NNd`, `NNw` (e.g. `24h`, `3d`, `1w`). |
| `--focus <filter>` | _none_ | Restrict memories and entities to a single focus. Accepts `person:Name`, `project:Name`, or `topic:Name`. Untyped values are treated as `topic:`. |
| `--format <markdown\|json>` | `markdown` | Output format. Markdown is human-friendly; JSON is stable for piping into other tools. |
| `--save` | _off_ | Write the rendered briefing to `<saveDir>/YYYY-MM-DD.<ext>`. Directory resolution: `briefing.saveDir` → `$REMNIC_HOME/briefings/` → `$HOME/.remnic/briefings/`. |

## MCP tool

The same builder is exposed as `remnic.briefing` over MCP (with `engram.briefing` retained as a legacy alias during the compatibility window). Input shape:

```json
{
  "since": "3d",
  "focus": "project:remnic-core",
  "namespace": "global",
  "format": "markdown",
  "maxFollowups": 4
}
```

The response includes both `markdown` and `json` representations along with the resolved `window` and, when applicable, a `followupsUnavailableReason` explaining why the follow-ups section was omitted.

## Configuration

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-remnic": {
        "config": {
          "briefing": {
            "enabled": true,
            "defaultWindow": "yesterday",
            "defaultFormat": "markdown",
            "maxFollowups": 5,
            "calendarSource": null,
            "saveByDefault": false,
            "saveDir": null,
            "llmFollowups": true
          }
        }
      }
    }
  }
}
```

| Key | Default | Notes |
|---|---|---|
| `enabled` | `true` | Set to `false` to hide the `remnic briefing` CLI and MCP tool entirely. |
| `defaultWindow` | `"yesterday"` | Default `--since` value when the user omits the flag. |
| `defaultFormat` | `"markdown"` | Default `--format` value. |
| `maxFollowups` | `5` | Clamped to `[0, 10]`. `0` disables the follow-ups section. |
| `calendarSource` | `null` | Path to an ICS or JSON file. When `null`, the "Today's calendar" section is omitted. |
| `saveByDefault` | `false` | If `true`, every CLI run writes a dated file. |
| `saveDir` | `null` | Override the save directory. Falls back to `$REMNIC_HOME/briefings/` or `$HOME/.remnic/briefings/`. |
| `llmFollowups` | `true` | Master switch for the Responses API call. |

## Calendar sources

`FileCalendarSource` can read two formats out of the box:

- **JSON** — an array of `CalendarEvent` objects, or a `{ "events": [...] }` wrapper. Minimum required fields: `title`/`summary`, `start`/`dtstart`. Optional: `end`, `location`, `notes`/`description`, `id`/`uid`.
- **ICS** (filename ends with `.ics`) — minimal `VEVENT` parsing: `SUMMARY`, `DTSTART`, `DTEND`, `LOCATION`, `DESCRIPTION`, `UID`. Basic date/datetime forms (`YYYYMMDDTHHMMSSZ` and `YYYYMMDD`) are normalized to ISO 8601.

Real calendar integrations (Google, iCloud, Microsoft) can plug into the same `CalendarSource` interface later without changing the briefing module.

## Graceful degradation

The briefing never throws on missing infrastructure:

- **No `OPENAI_API_KEY`** — the `## Suggested follow-ups` section renders as `_Unavailable: OPENAI_API_KEY not configured_`.
- **`llmFollowups: false`** or **`maxFollowups: 0`** — same graceful omission, different reason.
- **LLM error** (rate limit, network failure, bad response) — the error message is captured as `followupsUnavailableReason` and logged via the standard logger.
- **No calendar source** — the entire `## Today's calendar` section is omitted (not just empty).

## OpenAI Responses API

All LLM calls in this module go through `client.responses.create()` with fixed instructions that require strict JSON output. Chat Completions is never used, in keeping with the repository-wide policy.

## Privacy

Briefings are rendered entirely from local memory files and the optional local calendar source. No memory content leaves the host unless `llmFollowups` is enabled, in which case only the short summaries (thread titles, entity names, commitment texts) are sent to OpenAI — never full memory bodies.
