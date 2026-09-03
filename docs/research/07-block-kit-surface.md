# R7 — Block Kit / visual-rendering surface of agent-swarm's Slack integration

Scope: catalogue everything agent-swarm sends to Slack that has a visual shape (Block Kit blocks, mrkdwn, legacy attachments, modals, ephemeral responses, file uploads, reactions, message metadata) so the slack-mock HTML renderer knows exactly what it must support.

All line numbers below are from `/Users/taras/Documents/code/agent-swarm` at the commit checked out during this research (2026-09-03).

## 0. Two independent outbound rendering paths

agent-swarm has **two parallel, mutually exclusive** ways of posting the task tree/outcome to Slack, selected by the `SLACK_RENDER_V2` env flag:

- **v1 (default, `SLACK_RENDER_V2` unset/false)** — `src/slack/blocks.ts` builds classic Block Kit `section`/`context`/`actions` blocks with Slack **mrkdwn** text (`markdownToSlack()` converts GFM → mrkdwn). Used by `src/slack/responses.ts`, `src/slack/watcher.ts`, `src/slack/actions.ts`.
  - Verified default-off: `src/slack/render-v2.ts:64-66` `isSlackRenderV2Enabled() { return isEnvFlagEnabled("SLACK_RENDER_V2", false); }`
- **v2 (opt-in)** — `src/slack/render-v2.ts` renders the thread tree as a single `context` block of mrkdwn (`treeBlocks()`, line 281-286) but renders the **outcome card** via Slack's `chat.startStream` / `chat.appendStream` / `chat.stopStream` Web API trio using the `markdown_text` parameter — **raw GitHub-flavored Markdown**, NOT mrkdwn, NOT Block Kit (`src/slack/render-v2.ts:754-823`). Confirmed as a real, typed Slack Web API surface: `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/web-api/dist/types/request/chat.d.ts:145-190` (`ChatStartStreamArguments`/`ChatAppendStreamArguments`/`ChatStopStreamArguments`, each carrying `markdown_text` and `ChatStopStreamArguments.blocks` for a Block Kit footer appended at stream end).

Both paths matter for the mock, but **v1 is the one exercised by default** and should be the priority. v2's `markdown_text` is a genuinely different rendering mode (Slack auto-renders `#`, `**bold**`, fenced code, `[label](url)` links, and nested `-` lists as native Markdown — no mrkdwn conversion is applied to it: `src/slack/render-v2.ts:587-600`, confirmed byte-for-byte in the test at `src/tests/slack-render-v2.test.ts:1017-1063`, which asserts the streamed `markdown_text` contains `"# Complete result"`, `"**Bold text**"`, `"[a labeled link](https://example.com/result)"`, and a fenced ```` ```ts ```` block verbatim).

## 1. Block Kit block types used (outbound)

| Block type | Where built | Notes |
|---|---|---|
| `section` (mrkdwn text) | `blocks.ts:115-117` `sectionBlock()`; used by `buildCompletedBlocks`, `buildFailedBlocks`, `buildProgressBlocks`, `buildCancelledBlocks`, `buildAssignmentSummaryBlocks`, `buildTreeBlocks` (attachment lines), `responses.ts:100-103` (inline output chunks), `slack-post.ts:78-88`, `slack-reply.ts:105-114`, `slack-start-thread.ts:61-69`, `slack-update.ts:74-82` | The single workhorse block. Always `{type:"mrkdwn", text}`, never `fields[]` outbound. |
| `context` | `blocks.ts:108-113` `contextBlock()`; used for buffer-flush feedback (`buildBufferFlushBlocks`), tree-attachment overflow footer, and `slack-post.ts`/`slack-reply.ts` provenance footer (`"{agent} · {taskLink}"`); v2's whole tree render (`render-v2.ts:281-286`) and outcome footer (`render-v2.ts:684-728`) | `elements: [{type:"mrkdwn", text}]`, one element per call site (context blocks technically support up to 10 elements but agent-swarm only ever emits one). |
| `actions` | `blocks.ts:119-138` `cancelActionBlock()` — the only actions block agent-swarm builds; used in `buildProgressBlocks` and `buildTreeBlocks` (one per active root) | Single `button` element with `confirm` dialog. |
| `header` | `commands.ts:36-39,88-91` (slash-command ephemeral responses only) | `{type:"plain_text", text}`. Never used in channel/DM/thread messages, only in `/agent-swarm-status` and `/agent-swarm-help` ephemeral responses. |
| `divider` | `commands.ts:47-49` (`/agent-swarm-status` only) | No fields. |
| `input` | `actions.ts:43-58` — the `follow_up_task` modal's single input block | `block_id: "follow_up_input"`, element `plain_text_input`. |
| `rich_text` | **Inbound only** — never built by agent-swarm; parsed for text extraction (`message-text.ts:139-142,42-53`, handles `rich_text_section`/`rich_text_list`/`rich_text_quote`/`rich_text_preformatted` recursively) and by `AttachmentInputSchema`... no — rich_text is purely an *inbound* Slack-native block type real Slack sends for every human-typed message. | The mock must be able to *emit* `rich_text` blocks on synthetic user/slash messages if it wants to exercise this parser path, but agent-swarm itself never posts one. |
| `image` | **Not used** anywhere in outbound code (grep across `blocks.ts`, `render-v2.ts`, `responses.ts`, `actions.ts`, `commands.ts`, tools/*.ts found none). | Skip for MVP unless a future feature needs it. |

Arbitrary caller-supplied blocks: `slack-post`, `slack-reply`, `slack-start-thread` tools accept an optional `blocks: z.array(z.record(...)).max(50)` param (`slack-post.ts:28-32`, `slack-reply.ts:37-41`, `slack-start-thread.ts:22-26`) — an agent can pass **any valid Block Kit JSON**, not just the builders above, so the mock's renderer cannot assume a closed set of block shapes for agent-authored channel posts; it must render/gracefully-degrade whatever comes in.

## 2. Elements used

- **`button`** (`actions` block) — `blocks.ts:124-135`:
  ```json
  {
    "type": "button",
    "text": { "type": "plain_text", "text": "Cancel" },
    "action_id": "cancel_task",
    "value": "<taskId>",
    "style": "danger",
    "confirm": {
      "title": { "type": "plain_text", "text": "Cancel task?" },
      "text": { "type": "mrkdwn", "text": "This will cancel the task. Are you sure?" },
      "confirm": { "type": "plain_text", "text": "Yes, cancel" },
      "deny": { "type": "plain_text", "text": "Never mind" }
    }
  }
  ```
  This is the **only** button agent-swarm builds. `action_id="cancel_task"` is handled in `actions.ts:123-165`. No `url`-style link buttons, no other `style` values (`primary` never used), no other `action_id`s except `follow_up_task` and `view_task_logs` — but those two are referenced only in the `app.action(...)` handler registrations (`actions.ts:18,23`), i.e. their *button* block definitions live wherever the caller constructs them (not found in the files scoped for R7 — likely legacy/handlers.ts, out of scope here but worth a follow-up grep if the mock needs to click them).
- **`plain_text_input`** (modal `input` block) — `actions.ts:48-56`: `action_id: "follow_up_text"`, `multiline: true`, `placeholder`.
- **Text objects**: `mrkdwn` (`{type:"mrkdwn", text}`) is used for virtually everything (section/context text, button confirm dialog body). `plain_text` is used only for button labels, header text, modal titles/submit/close labels, and the input block's label/placeholder — i.e. plain_text never carries agent-authored content, only static UI chrome.
- **No** `static_select`, `overflow`, `checkboxes`, `radio_buttons`, `datepicker`, `multi_static_select`, `image` element, or `url`-type buttons found anywhere in outbound code.

## 3. mrkdwn features used

`markdownToSlack()` (`blocks.ts:46-75`) is the single conversion function applied to all agent-authored free text before it reaches a `section`/`context` block in the v1 path (also re-exported from `responses.ts:20` for tool call sites). It converts:

| GFM input | Slack mrkdwn output | Source line |
|---|---|---|
| `![alt](url "title")` | `alt (url)` — plain text + URL, no image markup | `blocks.ts:50-52` |
| `[text](url "title")` | `text (url)` — **deliberately not** `<url\|text>` because "Slack block auto-promotion has historically rejected that shortcut with `invalid_blocks`" | `blocks.ts:53-56` (comment explains the choice) |
| `# H1`..`###### H6` | `*Header*` (bold, via a private-use-area placeholder round-trip so it isn't re-mangled by the italic regex) | `blocks.ts:57-58` |
| `**bold**` / `__bold__` | `*bold*` | `blocks.ts:59-62` |
| `*italic*` (single asterisk, not adjacent to another `*`) | `_italic_` | `blocks.ts:64` |
| `_italic_` | unchanged (already valid mrkdwn) | comment at `blocks.ts:65` |
| `~~strike~~` | `~strike~` | `blocks.ts:69` |
| `` `code` `` / ```` ```code block``` ```` | unchanged — Slack's inline/fenced code syntax matches Markdown | comment `blocks.ts:70` |
| `- bullet` / numbered lists | unchanged — Slack renders GFM bullets natively | comment `blocks.ts:71` |
| 3+ consecutive blank lines | collapsed to 1 blank line | `blocks.ts:73` |

Separately, `getTaskLink()` (`blocks.ts:27-30`) always emits the real Slack mrkdwn link shortcut `<url|\`shortId\`>` for **internal dashboard links** — this is the one place agent-swarm *does* use `<url|label>`, deliberately, because it's not user-authored content going through the sanitizer above.

Other mrkdwn primitives seen in generated text (not via `markdownToSlack`, hand-built in template strings):
- User/channel mentions: `<@U…>` is rewritten by `rewriteSlackMentions()` (referenced in `assistant.ts:88`, not in R7 scope) before task text is stored; `<#C…>` channel mention appears in `assistant.ts:177` (`\n\n[User is viewing channel <#${ctx.channel_id}>]`).
- Emoji shortcodes `:crown:`, `:robot_face:`, `:gear:`, `:zap:`, `:rocket:`, `:star:`, `:crystal_ball:`, `:bulb:`, `:wrench:` used only as `icon_emoji` values for `chat.postMessage` persona override (`responses.ts:417-432` `getAgentEmoji()`), plus `:white_circle:`/`:large_blue_circle:`/`:black_circle:`/`:question:` inline in `/agent-swarm-status` mrkdwn text (`commands.ts:12-16`).
- Unicode emoji glyphs (not shortcodes) prefix status lines directly: `✅ ❌ 🚫 📡 ⏳ 👀 📎 🗂️ 📭 📨 ⏸️ ↪️ 💬 ⚠️` — see `STATUS_ICON` table `blocks.ts:377-390` and `statusIcon()` `render-v2.ts:105-118`.
- Bullet lists (`•`) hand-built (not Markdown `-`) in `formatAttachmentsBlockForSlack()` (`blocks.ts:178`: `` `• *${a.name}*${middle}${tail}` ``) and tree "and N more" lines.
- No strikethrough, no blockquote (`>`), no manual bullet/numbered-list mrkdwn syntax generation found outside the attachments block above (GFM lists pass through `markdownToSlack` unchanged per the comment at `blocks.ts:71`, so an agent's `- item` list in `output` renders as Slack's native bullet list without transformation).

## 4. Legacy `attachments` (color-bar) usage: **inbound-only, never outbound**

Grep across all outbound call sites (`chat.postMessage`/`chat.update`/`chat.startStream`/`chat.stopStream` callers in `blocks.ts`, `render-v2.ts`, `responses.ts`, `actions.ts`, `watcher.ts`, `commands.ts`, `tools/slack-*.ts`) found **zero** uses of the Slack `attachments` (legacy, color-bar) array as an outbound payload field. agent-swarm's own `TaskAttachment` concept (pointer-based artifacts: agent-fs paths, URLs, shared-fs paths, swarm Pages) is rendered as a plain mrkdwn bullet-list section (`formatAttachmentsBlockForSlack`, `blocks.ts:170-181`), not Slack's `attachments` field.

The legacy `attachments` array **is** parsed on the **inbound** side: `message-text.ts:10-18,76-122` extracts `fallback`/`text`/`title`/`title_link`/`pretext`/`fields[]`/`actions[].url` from third-party alert-app messages (Datadog/PagerDuty/GitHub bots) that post with legacy attachments instead of Block Kit. The mock should be able to *inject* messages carrying this shape (for testing agent-swarm's alert-ingestion path) even though agent-swarm's own bot never emits it.

## 5. Message metadata (`metadata.event_type` / `event_payload`)

Only used in the **v2** path: `render-v2.ts:411-414`
```json
{
  "metadata": {
    "event_type": "agent_swarm_render_v2",
    "event_payload": { "message_id": "<uuid>", "kind": "tree" }
  }
}
```
Attached to the `chat.postMessage` call that creates the thread tree (`SLACK_RENDER_METADATA_EVENT = "agent_swarm_render_v2"`, `render-v2.ts:47`), and later read back via `conversations.replies` with `include_all_metadata: true` (`render-v2.ts:324-343`) to reconcile a message that was posted but whose `ts` wasn't persisted (crash-recovery reconciliation). The v1 path never sets `metadata` on any outbound call. The mock's `chat.postMessage`/`conversations.replies` handlers must therefore round-trip `metadata` verbatim (echo it back in `conversations.replies` results) for v2 tests to pass.

## 6. Text fallback conventions

Every `chat.postMessage`/`chat.update` call sets a plain-text `text` fallback alongside `blocks`, per Slack's notification-fallback convention:
- `sendWithPersona()` (`responses.ts:387-415`) defaults `blocks` to a single mrkdwn section built from `text` when the caller passes none, and always forwards `text` as the fallback field.
- Completion messages: `text` is the plain body when the card is non-minimal, or a short `"✅ {agent} completed"` string when `slackReplySent` (minimal) — `responses.ts:166-169`.
- Tree messages: `text` is the joined `renderTree()` text — literally the same mrkdwn used in the block, not a separate summary (`watcher.ts` / `render-v2.ts:387,406`).
- `unfurl_links: false, unfurl_media: false` is set on **every single** outbound `chat.postMessage`/`chat.update` call found in scope (14+ call sites) — the mock should treat this as a near-universal default, not an occasional flag.

## 7. Modal view structure (`follow_up_submit`)

Full modal built in `actions.ts:34-60`, triggered by the `follow_up_task` button action:
```json
{
  "type": "modal",
  "callback_id": "follow_up_submit",
  "private_metadata": "<taskId>",
  "title": { "type": "plain_text", "text": "Follow-up" },
  "submit": { "type": "plain_text", "text": "Send" },
  "close": { "type": "plain_text", "text": "Cancel" },
  "blocks": [
    {
      "type": "input",
      "block_id": "follow_up_input",
      "label": { "type": "plain_text", "text": "Follow-up message" },
      "element": {
        "type": "plain_text_input",
        "action_id": "follow_up_text",
        "multiline": true,
        "placeholder": { "type": "plain_text", "text": "What would you like the agent to do next?" }
      }
    }
  ]
}
```
Opened via `client.views.open({ trigger_id, view })`. Submission handler `app.view("follow_up_submit", ...)` (`actions.ts:67-120`) reads `view.private_metadata` (the original taskId) and `view.state.values.follow_up_input.follow_up_text.value` (the typed message) — the mock's `views.open`/`view_submission` simulation must produce exactly this `state.values["<block_id>"]["<action_id>"].value` shape. No other modals exist in the scoped files (no `views.push`, no multi-block modals, no `select`/`checkbox` inputs anywhere).

## 8. Ephemeral slash-command responses

Both slash commands (`/agent-swarm-status`, `/agent-swarm-help`) `ack()` immediately then call `respond({ response_type: "ephemeral", blocks: [...] })` (`commands.ts:6-59,61-102`). These are the **only** two places `response_type: "ephemeral"` appears in the scoped files, and the only two places `header`/`divider` blocks appear. Both use `plain_text` for `header` and `mrkdwn` for `section` bodies; `/agent-swarm-help` conditionally appends an "Additive Slack" section only when `ADDITIVE_SLACK` env flag is on.

## 9. File / image upload surface

Single upload tool, `slack-upload-file.ts`, wraps `uploadFile()` in `src/slack/files.ts:92+` which calls Slack's **`filesUploadV2`** (confirmed by the mock in `src/tests/slack-upload-file.test.ts:15-27`, which stubs `client.filesUploadV2`). Key facts:
- What gets uploaded: **anything an agent chooses** — the tool is generic (`filePath` on the API server's shared filesystem, or inline `content` base64), described as "image, document, etc." (`slack-upload-file.ts:107`). No hardcoded "screenshots" or "logs" convention was found in the scoped files — agent-swarm doesn't itself take screenshots; that's the mock's own job for a different feature. Max size 1 GB (`MAX_FILE_SIZE = 1073741824`, `files.ts:9`).
- `initialComment` (optional, max 4000 chars) maps to Slack's `initial_comment` param and is posted alongside the file.
- Threading: `channel_id` + `thread_ts` are always passed. For **DM** tasks, `thread_ts` resolves to the *tree/progress message ts*, not the original thread root (`resolveTaskUploadThreadTs()`, `slack-upload-file.ts:15-25`: `task.slackTreeRootMessageTs ?? task.slackProgressMessageTs ?? task.slackThreadTs`). For **channel** tasks, it's always `task.slackThreadTs`. Verified in tests: `slack-upload-file.test.ts:74-134` — DM case uses the tree ts (`"1783331590.000001"`), channel case uses the original thread root (`"1783332000.000001"`) even though a different tree ts exists.
- No `title` param wired from the tool (schema has no `title` field even though `UploadFileOptions.title` exists in `files.ts:52` — dead/unused parameter from the tool's perspective).

## 10. Reactions (emoji names)

All via `client.reactions.add`/`client.reactions.remove`, never Block Kit but visually part of "what's on screen":
- **Acceptance/progress reactions** added on inbound messages: `eyes` (first ack, `handlers.ts:656,759,775`, `assistant.ts:154,192,212`), `heavy_plus_sign` (buffered follow-up append, `handlers.ts:575-582`, `assistant.ts:131-136`), `speech_balloon` (a third state in `handlers.ts:740`, not seen in the `assistant.ts` path), and `zap` (added directly, outside the scoped R7 files, on the `!now` instant-flush command: `handlers.ts:540` `client.reactions.add({channel: msg.channel, name: "zap", timestamp: msg.ts})`). `ack.ts:45` removes all four of these on finalize.
- **Terminal reactions**: `finalizeSlackMessageReaction()` (`ack.ts:39-58`) first removes all of `["eyes","heavy_plus_sign","zap","speech_balloon"]`, then adds `white_check_mark` (all linked tasks completed) or `x` (any failed/cancelled) — `ack.ts:60-91,93-105`.
- `already_reacted` on add and `no_reaction`/`message_not_found` on remove are treated as expected no-ops (`ack.ts:31,50`) — the mock's `reactions.add`/`reactions.remove` should return these Slack error codes for the corresponding edge cases so agent-swarm's error-swallowing logic can be exercised.

## 11. Truncation limits enforced

| Constant | Value | File:line | Purpose |
|---|---|---|---|
| `MAX_SECTION_LENGTH` | 2900 | `blocks.ts:13` | Section text split threshold (Slack hard cap is 3000; 100-char safety margin). `splitSlackSectionText()` (`blocks.ts:80-104`) splits on newline, then space, then hard-cuts. |
| `MAX_BLOCKS_PER_COMPLETION_MESSAGE` | 45 | `blocks.ts:14` | `buildCompletedBlockBatches()` (`blocks.ts:265-290`) splits a completion card into multiple messages when it would exceed this (Slack's real cap is 50 blocks/message). |
| `SLACK_ATTACHMENTS_MAX` | 20 | `blocks.ts:144` | Cap on `TaskAttachment[]` lines rendered per completion card / per tree node (`formatAttachmentsBlockForSlack`). Mirrors `store-progress`'s own input cap. |
| `SLACK_TREE_ATTACHMENT_BLOCKS_MAX` | 10 | `blocks.ts:513` | Cap on how many completed-node attachment blocks appear per tree message; overflow becomes a `"… and M more completed tasks with attachments"` context footer (`blocks.ts:573-582`). |
| Tool `blocks` array | `.max(50)` | `slack-post.ts:30`, `slack-reply.ts:39`, `slack-start-thread.ts:24` | Zod-enforced; effectively 49 when a provenance `context` footer is appended (explicit check `messageBlocks.length >= 50` → error, `slack-post.ts:90-92`, `slack-reply.ts:117-119`). |
| `attachments` input | `.max(20)` | `store-progress.ts:94` | Zod cap on attachments per `store-progress` call (de-duped, accumulates across calls). |
| `message`/`initialComment` text | `.max(4000)` | `slack-post.ts:27`, `slack-reply.ts:36`, `slack-start-thread.ts:21`, `slack-upload-file.ts:151-155` | Tool input schema cap (below Slack's real ~40k message-text ceiling; a defensive app-level limit). |
| `MAX_OUTCOME_MARKDOWN_LENGTH` (v2 only) | 12,000 | `render-v2.ts:41` | Cap on the `markdown_text` streamed to `chat.startStream`; `outcomePresentation()`/`safeMarkdownBoundary()` (`render-v2.ts:658-669,625-656`) truncate at a safe line/word boundary *outside* any open code fence, then append `"… [View full task output](url)"`. |
| `MAX_TITLE_LENGTH` (v2) | 72 | `render-v2.ts:40` | Truncates task labels/titles in the tree render. |
| `MAX_TREE_NODE_LINE_LENGTH` (v2) | 1,000 | `render-v2.ts:42` | Per-node line hard cap in the v2 tree text. |
| `MAX_TREE_PREFIX_LENGTH` (v2) | 120 | `render-v2.ts:43` | Indentation prefix cap for deeply nested trees. |
| `MAX_TREE_PROGRESS_LENGTH` (v2) | 60 | `render-v2.ts:44` | Progress-text truncation appended to a v2 tree line. |
| `MAX_INLINE_OUTPUT_BLOCKS_PER_MESSAGE` | 10 | `responses.ts:45` | Batches of 2900-char section chunks per message when streaming long inline completion output (keeps message under Slack's ~40,000-char total). |
| `MAX_VISIBLE_CHILDREN` (v1 tree) | 8 | `blocks.ts:392` | v1 tree render shows at most 8 children per root, then `"↳ _and N more..._"`. |
| `MAX_OUTPUT_LENGTH` (v1 tree child detail) | 120 | `blocks.ts:393` | Truncates a completed child's inline output to first sentence or 120 chars. |

## 12. Representative real JSON payload examples

1. **Completion card, non-minimal** (`buildCompletedBlocks`, exercised implicitly by `responses.ts:117-193`; shape confirmed by `blocks.ts:244-256`):
```json
[
  { "type": "section", "text": { "type": "mrkdwn", "text": "✅ *Researcher* (<https://app.agent-swarm.dev/tasks/1a2b3c4d-...|`1a2b3c4d`>) · 4m" } },
  { "type": "section", "text": { "type": "mrkdwn", "text": "Investigated the flaky test and fixed the race condition in `queue.ts`." } }
]
```

2. **Failed task card** (`buildFailedBlocks`, `blocks.ts:296-307`):
```json
[
  { "type": "section", "text": { "type": "mrkdwn", "text": "❌ *Worker* (<https://app.agent-swarm.dev/tasks/...|`abcd1234`>) · 12s" } },
  { "type": "section", "text": { "type": "mrkdwn", "text": "```Connection refused: could not reach staging DB```" } }
]
```

3. **Progress card with cancel button** (`buildProgressBlocks` + `cancelActionBlock`, `blocks.ts:313-323,119-138`):
```json
[
  { "type": "section", "text": { "type": "mrkdwn", "text": "*Lead* (<https://app.agent-swarm.dev/tasks/...|`ffff0000`>): Reading source files..." } },
  {
    "type": "actions",
    "elements": [{
      "type": "button",
      "text": { "type": "plain_text", "text": "Cancel" },
      "action_id": "cancel_task",
      "value": "ffff0000-...",
      "style": "danger",
      "confirm": {
        "title": { "type": "plain_text", "text": "Cancel task?" },
        "text": { "type": "mrkdwn", "text": "This will cancel the task. Are you sure?" },
        "confirm": { "type": "plain_text", "text": "Yes, cancel" },
        "deny": { "type": "plain_text", "text": "Never mind" }
      }
    }]
  }
]
```

4. **v1 tree-status message with mixed child states** (`buildTreeBlocks`, `blocks.ts:552-592`):
```json
[
  { "type": "section", "text": { "type": "mrkdwn", "text": "✅ *Lead* (<https://app.agent-swarm.dev/tasks/...|`aaaa1111`>) · 8m\n↳ ⏳ *Researcher* (<...|`bbbb2222`>) · 3m\n    Reading Slack docs\n↳ ❌ *Worker* (<...|`cccc3333`>) · 45s\n    Error: connection timeout" } },
  { "type": "actions", "elements": [ { "type": "button", "text": { "type": "plain_text", "text": "Cancel" }, "action_id": "cancel_task", "value": "aaaa1111-...", "style": "danger", "confirm": { "...": "..." } } ] }
]
```

5. **v2 tree message** (`treeBlocks`, `render-v2.ts:281-286`, text format verified verbatim in `src/tests/slack-render-v2.test.ts:670-678`):
```json
{
  "channel": "C_TREE_SHAPE",
  "thread_ts": "100.1",
  "text": "🧵 worked for 8m05s\n ↳ ⏳ format tests · 8m05s · <https://app.agent-swarm.dev/tasks/AAAA|`AAAAAAAA`>\n    ↳ ⏳ Researcher · 8m05s · <...|`BBBBBBBB`> · Reading *Slack docs* carefully…\n       ↳ ✅ Researcher · 4m · <...|`CCCCCCCC`>\n ↳ ⏳ ship this PR · 8m05s · <...|`DDDDDDDD`>",
  "blocks": [{ "type": "context", "elements": [{ "type": "mrkdwn", "text": "🧵 worked for 8m05s\n ↳ ⏳ format tests ..." }] }],
  "unfurl_links": false,
  "unfurl_media": false,
  "metadata": { "event_type": "agent_swarm_render_v2", "event_payload": { "message_id": "<uuid>", "kind": "tree" } }
}
```

6. **v2 outcome stream start** (`chat.startStream`, `render-v2.ts:754-791`, exact assertion from `src/tests/slack-render-v2.test.ts:1051-1061`):
```json
{
  "channel": "C_OUTCOME_MARKDOWN",
  "thread_ts": "100.1",
  "markdown_text": "✅\n\n# Complete result\n\n**Bold text** and [a labeled link](https://example.com/result).\n\n- first item\n  - nested item\n\n```ts\nconst message = \"preserved\";\n```\n\nLong section: native markdown remains intact. ...",
  "username": "Markdown Lead",
  "icon_emoji": ":crown:"
}
```

7. **Attachments block appended to a completion body** (`formatAttachmentsBlockForSlack`, `blocks.ts:170-181`):
```json
{
  "type": "section",
  "text": {
    "type": "mrkdwn",
    "text": "Fixed the bug and verified with a screenshot.\n\n*Attachments (2):*\n• *report* — _primary deliverable_ — https://example.com/r.pdf\n• *diff.patch* — https://app.example.test/pages/abc123"
  }
}
```

8. **`follow_up_submit` modal open payload** (`actions.ts:34-60`):
```json
{
  "trigger_id": "<trigger_id>",
  "view": {
    "type": "modal",
    "callback_id": "follow_up_submit",
    "private_metadata": "1a2b3c4d-...",
    "title": { "type": "plain_text", "text": "Follow-up" },
    "submit": { "type": "plain_text", "text": "Send" },
    "close": { "type": "plain_text", "text": "Cancel" },
    "blocks": [
      {
        "type": "input",
        "block_id": "follow_up_input",
        "label": { "type": "plain_text", "text": "Follow-up message" },
        "element": {
          "type": "plain_text_input",
          "action_id": "follow_up_text",
          "multiline": true,
          "placeholder": { "type": "plain_text", "text": "What would you like the agent to do next?" }
        }
      }
    ]
  }
}
```

## 13. Recommended minimal renderer scope for the MVP

**Must render faithfully (high frequency, exercised by default/v1 path and by the tests in scope):**
- `section` block with `mrkdwn` text: bold (`*x*`), italic (`_x_`), inline code (`` `x` ``), fenced code blocks, native GFM bullet/numbered lists, `<url|label>` links (task-link shortcut), plain bare URLs, unicode emoji glyphs, `:emoji_shortcode:` glyphs, strikethrough (`~x~`).
- `context` block (single mrkdwn element) — visually a smaller/greyed line under a section; used constantly for tree lines, footers, buffer-flush notices.
- `actions` block with a single `button` (styled `danger`) + its `confirm` dialog — needed to make the tree/progress cards visually accurate (button + hover confirm) even if the mock doesn't need to execute the click for HTML screenshots.
- Message-level `username`/`icon_emoji` persona override on `chat.postMessage` — every agent-authored message changes display name/avatar per-call; the renderer must respect per-message identity, not a single static bot identity.
- Multi-message batching visuals: when a completion card exceeds 45 blocks it becomes multiple sequential thread messages (`"continued 2/3"` header) — worth rendering as separate message bubbles in the thread.

**Should render (lower frequency but simple, low implementation cost):**
- `header` and `divider` blocks — only appear in ephemeral slash-command responses, straightforward static markup.
- `input`/modal rendering for `follow_up_submit` — needed only if the mock/tests simulate `views.open` + `view_submission`; otherwise can be stubbed as a non-visual API acknowledgement.
- Attachments bullet-list rendering (just more `section` mrkdwn text, no special block type) — already covered by the mrkdwn renderer above; no extra work.
- `metadata.event_type`/`event_payload` round-trip on `chat.postMessage` and `conversations.replies` — required for v2 tests but invisible in a screenshot; implement as opaque JSON passthrough, not a rendering concern.

**Can degrade to plain text / defer (low frequency, or only reachable via the opt-in v2 path or free-form agent-authored blocks):**
- `markdown_text` GFM rendering for `chat.startStream`/`appendStream`/`stopStream` — only reachable when `SLACK_RENDER_V2=true` (off by default). If the mock's screenshot renderer already renders GFM Markdown for its own preview needs, this is nearly free to reuse; otherwise defer until v2 is actually turned on in a test.
- Arbitrary caller-supplied Block Kit JSON via `slack-post`/`slack-reply`/`slack-start-thread`'s optional `blocks` param — since an agent can pass literally any valid Block Kit, perfect fidelity is unbounded scope. Recommend: render the block types already catalogued above faithfully, and for anything else (e.g. `image`, `static_select`, `divider` mid-thread, `fields[]` on a section) fall back to a generic "unsupported block: {type}" placeholder rather than trying to implement full Block Kit.
- Legacy `attachments` (color-bar) rendering — only needed to *simulate inbound* alert-bot messages for testing `extractSlackMessageText()`; a simple flat rendering (pretext/title/text/fields joined, no color bar) is enough — agent-swarm's own bot never emits this shape, so pixel-perfect color-bar fidelity has no test value.
- `rich_text` block rendering — only needed as an *inbound* fixture shape (real Slack always sends it for human messages); the mock needs to be able to **construct** `rich_text` JSON for injected test messages, but does not need to **render** it as HTML unless screenshotting a simulated human message specifically (in which case, treating its extracted plain text as a mrkdwn section is a reasonable approximation).
- Assistant-panel chrome (`setStatus`, `setTitle`, `setSuggestedPrompts` via `assistant.threads.*` Web API methods, `assistant.ts:33-40,62-75`) — these render in Slack's native Assistant side-panel UI, not as blocks in the channel/thread transcript. Out of scope for an HTML *channel/thread* renderer; implement only as no-op/ack API stubs.
