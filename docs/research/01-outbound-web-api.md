# R1 — Outbound Slack Web API surface of agent-swarm

Scope: every bot → Slack call made by `/Users/taras/Documents/code/agent-swarm`, excluding `src/tests/**`.
All paths are absolute. All line numbers verified by reading the file.

Repo facts:
- Bolt app is constructed at `/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:44-49` with
  `new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true, logLevel })`.
  Every outbound call in this report goes through that single `App`'s `app.client` (`WebClient`).
- Manifest scopes live at `/Users/taras/Documents/code/agent-swarm/slack-manifest.json:40-78`.

---

## 0. Summary table

| Method | Call sites | Transport |
| --- | --- | --- |
| `chat.postMessage` | 14 typed + 1 via `apiCall` | `client.chat.postMessage` / `callSlackWithRetry` |
| `chat.update` | 5 typed + 3 via `apiCall` | same |
| `chat.delete` | 1 | typed |
| `chat.getPermalink` | 1 (3 logical callers) | `apiCall` |
| `chat.startStream` | 1 | `apiCall` |
| `chat.stopStream` | 1 | `apiCall` |
| `conversations.replies` | 4 typed + 1 via `apiCall` | mixed |
| `conversations.history` | 3 | typed |
| `conversations.list` | 2 | typed |
| `conversations.info` | 1 | typed |
| `conversations.join` | 1 | typed |
| `conversations.create` | 1 | typed |
| `conversations.invite` | 2 | typed |
| `conversations.archive` | 1 | typed |
| `auth.test` | 4 typed + 1 via `apiCall` | mixed |
| `users.info` | 2 | typed |
| `reactions.add` | 2 | typed |
| `reactions.remove` | 1 | typed |
| `files.info` | 1 | typed |
| `files.uploadV2` (`client.filesUploadV2`) | 1 | SDK helper (multi-step) |
| `views.open` | 1 | typed |
| `assistant.threads.setStatus` | 1 typed + Bolt `setStatus` | typed + Bolt |
| `assistant.threads.setTitle` | Bolt `setTitle` only | Bolt middleware |
| `assistant.threads.setSuggestedPrompts` | Bolt `setSuggestedPrompts` only | Bolt middleware |
| `apps.event.authorizations.list` / `auth.teams.list` | (Bolt internals only, out of scope) | — |
| `response_url` POST (slash-command `respond()`) | 2 | Bolt `respond` (raw HTTPS to `hooks.slack.com`) |
| raw `fetch()` on `url_private_download` | 1 | `node fetch` |
| raw `fetchJson` on `https://slack.com/api/conversations.replies` | 1 (seed script) | script sandbox |

**Not used anywhere** (verified by grep): `chat.postEphemeral`, `chat.scheduleMessage`,
`files.upload` (v1), `files.getUploadURLExternal` / `files.completeUploadExternal` called directly
(the SDK helper does this internally), `users.lookupByEmail`, `users.list`, `conversations.members`,
`conversations.open`, `conversations.setTopic`, `conversations.setPurpose`, `views.update`,
`views.publish`, `views.push`, `pins.*`, `bookmarks.*`, `search.messages`, `team.info`, `bots.info`,
`reminders.*`, `usergroups.*`, `emoji.list`.

---

## 1. Retry / error-code plumbing (shared)

### `callSlackWithRetry` — the only retry wrapper
`/Users/taras/Documents/code/agent-swarm/src/slack/render-v2.ts:88-103`

```ts
export async function callSlackWithRetry(
  client: WebClient, method: string, payload: Record<string, unknown>,
): Promise<SlackApiResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.apiCall(method, payload)) as SlackApiResult;
    } catch (error) {
      const delay = retryDelayMs(error, attempt);
      if (delay === null || attempt >= MAX_SLACK_RETRIES) throw error;
      console.warn(`[Slack] ${method} rate limited; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}
```

`retryDelayMs` (`render-v2.ts:72-86`) only retries rate limits. It matches
`error.code === "slack_webapi_rate_limited_error"` **or** `error.data.error === "ratelimited"`,
then waits `min(max((error.retryAfter ?? error.data.retry_after ?? 2**attempt) * 1000, 0), 30_000)`.
Constants: `MAX_SLACK_RETRIES = 3` (`render-v2.ts:38`), `MAX_RETRY_DELAY_MS = 30_000` (`:39`).

There is **no** `SLACK_RETRIES` env var. The seed list's `SLACK_RETRIES` is `MAX_SLACK_RETRIES`.

Everything **outside** `render-v2.ts` uses the raw `WebClient` with no retry at all. The
`@slack/web-api` client's own `retryConfig` default still applies (library internals, out of scope).

### Slack error-code extraction helpers
- `/Users/taras/Documents/code/agent-swarm/src/slack/channel-join.ts:118-126` — `slackErrorData(error)` reads
  `(error as {data}).data`; `slackCode(error)` returns `data.error` when it is a string.
  Comment at `:116-117` records the contract: `@slack/web-api` platform errors set
  `message = "An API error occurred: <code>"` and put the **full Slack response body** on `error.data`.
  **The mock must return `{ ok:false, error:"<code>", ... }` with HTTP 200 so the SDK produces this shape.**
- `channel-join.ts:128-136` — `slackMissingScopeMessage(error)` reads `data.error === "missing_scope"`
  and `data.needed` (a string of scope names).
- `/Users/taras/Documents/code/agent-swarm/src/slack/ack.ts:8-13` — local `slackErrorCode`.
- `/Users/taras/Documents/code/agent-swarm/src/slack/responses.ts:29-39` — `classifySlackUpdateError`
  maps `message_not_found | channel_not_found | thread_not_found` → `"not_found"`, everything else → `"failed"`.
- `/Users/taras/Documents/code/agent-swarm/src/slack/render-v2.ts:312-314` — `isSlackMessageNotFound`
  (`data.error === "message_not_found"`).
- `/Users/taras/Documents/code/agent-swarm/src/slack/render-v2.ts:671-674` — `isStreamAlreadyStopped`
  (`data.error === "message_not_in_streaming_state"`).

### `withAutoJoin` — the auto-join wrapper
`/Users/taras/Documents/code/agent-swarm/src/slack/channel-join.ts:171-201`

```ts
try { return await fn(); }
catch (error) {
  if (slackCode(error) !== "not_in_channel") throw error;
  if (await isKnownExternalChannel(client, channelId)) throw new Error("Cannot auto-join external channel …");
  try { await client.conversations.join({ channel: channelId }); }
  catch (joinError) {
    if (slackCode(joinError) === "method_not_supported_for_channel_type")
      throw new Error("Cannot access private channel …");
    throw joinError;
  }
  return await fn();   // retried exactly once
}
```

`isKnownExternalChannel` (`channel-join.ts:144-159`) calls `conversations.info` and reads
`channel.is_ext_shared` and `channel.is_pending_ext_shared`; on any throw it logs and returns `false`.

Wrapped call sites: `slack-post.ts:104`, `slack-reply.ts:131`, `slack-start-thread.ts:71`,
`slack-read.ts:176` and `:182`.

---

## 2. `chat.postMessage`

### 2.1 `sendWithPersona` — the shared persona poster
`/Users/taras/Documents/code/agent-swarm/src/slack/responses.ts:387-415`

Args: `channel`, `thread_ts`, `text`, `unfurl_links: false`, `unfurl_media: false`,
`username`, `icon_emoji`, `blocks` (defaults to one `section`/`mrkdwn` block built from `text`).
Response read: **`result.ts` only**.

Callers (all pass `username = getAgentDisplayName(agent)`, `icon_emoji = getAgentEmoji(agent)`):
- `responses.ts:94` — `sendInlineTaskOutput`, batched 10 section blocks per message
  (`MAX_INLINE_OUTPUT_BLOCKS_PER_MESSAGE = 10`, `responses.ts:45`).
- `responses.ts:163` — `sendTaskResponse` completed path, one call per block batch.
- `responses.ts:178` — `sendTaskResponse` failed path, `text = "Task failed: <reason>"`.
- `responses.ts:215` — `sendProgressUpdate`, returns the `ts` for later `chat.update` tracking.
- `responses.ts:332` — `updateToFinal` continuation batches (`i >= 1`).

`getAgentDisplayName` (`responses.ts:50-52`) prefixes `(dev) ` when `process.env.ENV === "development"`.
`getAgentEmoji` (`responses.ts:417-433`) returns `:crown:` for leads, else a name-hash pick from
`[":robot_face:", ":gear:", ":zap:", ":rocket:", ":star:", ":crystal_ball:", ":bulb:", ":wrench:"]`.

### 2.2 Direct `chat.postMessage` call sites

| # | Site | Args | Response fields read | Errors handled |
| --- | --- | --- | --- | --- |
| 1 | `src/slack/responses.ts:402` | see 2.1 | `ts` | caller try/catch only |
| 2 | `src/slack/actions.ts:109` | `channel`, `thread_ts`, `text` (`"💬 Follow-up sent to *<agent>* (<link>)"`), `unfurl_links:false`, `unfurl_media:false`, optional `username`+`icon_emoji` | none | logged only |
| 3 | `src/slack/watcher.ts:479` | `channel`, `thread_ts`, `text` (`"Task in progress: <agent>"`), `unfurl_links:false`, `unfurl_media:false`, `username`, `icon_emoji`, `blocks` (`buildTreeBlocks`) | `result.ts` | logged only |
| 4 | `src/slack/thread-buffer.ts:179` | `channel`, `thread_ts`, `text` (steering ack), `unfurl_links:false`, `unfurl_media:false`, optional `username`+`icon_emoji` | none | logged only |
| 5 | `src/slack/thread-buffer.ts:245` | `channel`, `thread_ts`, `text`, `unfurl_links:false`, `unfurl_media:false`, optional `username`+`icon_emoji`, `blocks` (`buildBufferFlushBlocks`) | `result.ts` → `registerTreeMessage` | logged only |
| 6 | `src/slack/render-v2.ts:403` (via `apiCall`) | `channel`, `thread_ts`, `text`, `blocks` (`treeBlocks`), `unfurl_links:false`, `unfurl_media:false`, optional `username`+`icon_emoji`, **`metadata: { event_type: "agent_swarm_render_v2", event_payload: { message_id, kind: "tree" } }`** | `remote.ts` (throws `"Slack did not return a timestamp for the thread tree"` when missing) | rate-limit retry |
| 7 | `src/tools/slack-reply.ts:132` | `channel`, `thread_ts`, `text`, `unfurl_links:false`, `unfurl_media:false`, `username`, `icon_emoji`, `blocks` | `result.ts` | wrapped in `withAutoJoin` |
| 8 | `src/tools/slack-post.ts:105` | `channel`, `text`, `unfurl_links:false`, `unfurl_media:false`, `username`, `icon_emoji`, optional `thread_ts`, `blocks` | `result.ts` | `withAutoJoin` |
| 9 | `src/tools/slack-start-thread.ts:72` | `channel`, `text`, `unfurl_links:false`, `unfurl_media:false`, `username`, `icon_emoji`, `blocks` | **`result.ts` AND `result.channel`** (`result.channel ?? channelId`, `slack-start-thread.ts:85`) | `withAutoJoin` |
| 10 | `src/queue-stall-alarm.ts:134` | `channel` (`SLACK_ALERTS_CHANNEL`), `text`, `unfurl_links:false`, `unfurl_media:false` | none | throws upward |
| 11 | `src/oauth/keepalive.ts:79` | `channel` (`SLACK_ALERTS_CHANNEL`), `text`, `unfurl_links:false`, `unfurl_media:false` | none | logs `err.code` and `JSON.stringify(err.data)` (`keepalive.ts:86-99`) |
| 12 | `src/jira/webhook-lifecycle.ts:56` | same shape as #11 | none | logs `err.code` + `err.data` (`:63-75`) |
| 13 | `src/workflows/approval-notifications.ts:47` | `channel` (notification target), `thread_ts` (stored `messageTs`), `text`, `unfurl_links:false`, `unfurl_media:false` | none | releases the DB claim on failure |
| 14 | `src/workflows/executors/notify.ts:68` | `channel: config.target \|\| ""`, `text`, `unfurl_links:false`, `unfurl_media:false` | `result.ts` → `output.messageId` | returns `status:"failed"` |
| 15 | `src/workflows/executors/human-in-the-loop.ts:258` | `channel`, `text` (`"Approval Required: <title> — <url>"`), `unfurl_links:false`, `unfurl_media:false`, `blocks` (section + `actions` with a **URL button**) | `result.ts` → persisted as `messageTs` | logged only |

Blocks size guards: a provenance `context` footer is appended by `slack-reply.ts:116-129` and
`slack-post.ts:89-102`, both refusing when `messageBlocks.length >= 50`
(`"At most 49 blocks are allowed when a provenance footer is added."`).

---

## 3. `chat.update`

| # | Site | Args | Response read | Errors handled |
| --- | --- | --- | --- | --- |
| 1 | `src/slack/responses.ts:255` (`updateProgressInPlace`) | `channel`, `ts`, `text`, `unfurl_links:false`, `unfurl_media:false`, `blocks` | none | `classifySlackUpdateError` → `"not_found"` on `message_not_found`/`channel_not_found`/`thread_not_found`, so the watcher reposts |
| 2 | `src/slack/responses.ts:328` (`updateToFinal`) | same shape | none | try/catch → `false` |
| 3 | `src/slack/responses.ts:372` (`updateTreeMessage`) | `channel`, `ts`, `text` (fallback), `unfurl_links:false`, `unfurl_media:false`, `blocks` | none | `classifySlackUpdateError` |
| 4 | `src/slack/actions.ts:159` (cancel button) | `channel`, `ts` (`body.message.ts`), `text:"Task cancelled"`, `unfurl_links:false`, `unfurl_media:false`, `blocks` | none | logged only |
| 5 | `src/tools/slack-update.ts:84` | `channel`, `ts` (`parseSlackTs(messageTs)`), `text`, `unfurl_links:false`, `unfurl_media:false`, `blocks` (single `section`) | `result.ts` | explicit switch on `message_not_found`, `cant_update_message`, `edit_window_closed`, `channel_not_found`, `not_in_channel` (`slack-update.ts:92-110`) |
| 6 | `src/slack/render-v2.ts:421` (reconcile path) | `channel`, `ts`, `text`, `blocks`, `unfurl_links:false`, `unfurl_media:false` | none | rate-limit retry |
| 7 | `src/slack/render-v2.ts:552` (tree redraw) | same as #6 | none | rate-limit retry + `isSlackMessageNotFound` → `"missing"` → tree replaced (`render-v2.ts:560-563, 570-573`) |
| 8 | `src/slack/render-v2.ts:806` (pre-stop stream overwrite) | `channel`, `ts`, **`text` only** (no blocks) | none | rate-limit retry |

`ChatUpdatePayload` type (`responses.ts:24-27`, `actions.ts:11-14`) forces `unfurl_links:false` and
`unfurl_media:false` on every typed update.

---

## 4. `chat.delete`

`/Users/taras/Documents/code/agent-swarm/src/tools/slack-delete.ts:56`
Args: `channel`, `ts` (`parseSlackTs`). No response fields read.
Error switch (`:64-79`): `message_not_found`, `cant_delete_message`, `channel_not_found`, `not_in_channel`.

---

## 5. `chat.getPermalink` (render-v2 only)

`/Users/taras/Documents/code/agent-swarm/src/slack/render-v2.ts:288-297` (`resolvePermalink`)
Args: `channel`, `message_ts`. Reads `result.permalink`; throws
`"Slack did not return a permalink for <channel>/<ts>"` when it is not a non-empty string.

Callers:
- `ensureTreePermalink` (`render-v2.ts:299-306`) — persists the permalink on the tree row.
- `streamOutcomeCard` (`render-v2.ts:824`) — after the stream is stopped.
- `processSlackRenderV2` (`render-v2.ts:887`) — a **liveness probe** for the tree message;
  a `message_not_found` here triggers `replaceMissingTree`.

---

## 6. `chat.startStream` / `chat.stopStream` (streaming outcome card)

These are the newest Slack streaming-message methods. `streamOutcomeCard`
(`/Users/taras/Documents/code/agent-swarm/src/slack/render-v2.ts:731-826`).

`chat.startStream` (`render-v2.ts:791`), payload built at `:754-770`:
- `channel`, `thread_ts`, **`markdown_text`** (not `text`/`blocks`)
- optional `username`, `icon_emoji`
- when the channel does **not** start with `"D"` and the task has a `slackUserId`:
  `recipient_user_id` and `recipient_team_id` (team id from `auth.test`, see §11).
Response read: `started.ts` (throws `"Slack did not return a timestamp for the outcome stream"`).

`chat.stopStream` (`render-v2.ts:813`):
- `channel`, `ts`, `blocks` (the `outcomeFooter` context block: `duration · who · task link`).
- Catch: `isStreamAlreadyStopped` (`data.error === "message_not_in_streaming_state"`) is swallowed;
  anything else rethrows.

---

## 7. `conversations.replies`

| # | Site | Args | Response read | Notes |
| --- | --- | --- | --- | --- |
| 1 | `src/slack/handlers.ts:243` | `channel`, `ts`, `limit: 1`, `inclusive: true` | `resp.messages[0]` → `.bot_id`, `.user` | detects "thread started by swarm"; result cached per thread (`SWARM_THREAD_ROOT_CACHE_MAX`, `handlers.ts:256-260`) |
| 2 | `src/slack/handlers.ts:296` | `channel`, `ts`, `limit: 20` | `result.messages[]` → `ts`, `user`, `bot_id`, `subtype`, plus text via `extractSlackMessageText` | builds `<thread_context>` |
| 3 | `src/slack/thread-buffer.ts:96` | `channel`, `ts`, `limit: 20` | `result.messages[]` → `user`, `bot_id`, `subtype`, text | buffer flush context |
| 4 | `src/tools/slack-read.ts:177` | `channel`, `ts`, `limit` (1..100, tool arg) | `result.messages[]` → `user`, `bot_id`, `username`, `subtype`, `text`, `ts`, `files[]`, `attachments[]`, `blocks[]` | wrapped in `withAutoJoin` |
| 5 | `src/slack/render-v2.ts:324` (`findReservedSlackMessage`) | `channel`, `ts`, **`include_all_metadata: true`**, `oldest` (reservation `createdAt` seconds − 5, as a string), `inclusive: true`, `limit: 100`, optional `cursor` | `response.messages[]` → `ts`, `text`, **`metadata.event_type`**, **`metadata.event_payload.message_id`**; `response.response_metadata.next_cursor` for pagination | reconciles an orphaned reservation |

`extractSlackMessageText` lives at `/Users/taras/Documents/code/agent-swarm/src/slack/message-text.ts`
and pulls text out of `text`, `attachments[].fallback|text|title|pretext`, and `blocks[]`.

---

## 8. `conversations.history`

| # | Site | Args | Response read |
| --- | --- | --- | --- |
| 1 | `src/slack/channel-activity.ts:75` (cold-start seed) | `channel`, `limit: 1` | `seedResult.messages[0].ts` |
| 2 | `src/slack/channel-activity.ts:86` (poll) | `channel`, `oldest: cursor`, `limit` | `historyResult.messages[]` → `ts`, `bot_id`, `subtype`, `user`, `text`, `thread_ts` |
| 3 | `src/tools/slack-read.ts:183` | `channel`, `limit` | same field set as `conversations.replies` #4 |

`channel-activity.ts:112-115` swallows every error per channel with a warning
("channel might have been archived or bot removed"). No pagination on history.

---

## 9. `conversations.list`

| # | Site | Args | Response read |
| --- | --- | --- | --- |
| 1 | `src/slack/channel-activity.ts:160-165` (`fetchAllBotChannels`) | `types: "public_channel,private_channel"`, `exclude_archived: true`, `limit: 200`, `cursor` | `result.channels[]` → `id`, `name`, `is_member`; **`result.response_metadata.next_cursor`** (loops until empty) |
| 2 | `src/tools/slack-list-channels.ts:74-78` | `types` (mapped from `public\|private\|dm\|mpim` → `public_channel,private_channel,im,mpim`), `limit` (1..200, default 100), `exclude_archived: true` | `result.channels[]` → `id`, `name`, `is_im`, `is_mpim`, `is_private`, `is_member`, `num_members`, `user` (**no** cursor paging here) |

For DM entries `slack-list-channels.ts:108` resolves a display name via `users.info` (see §12).

---

## 10. `conversations.info` / `.join` / `.create` / `.invite` / `.archive`

- `conversations.info` — `/Users/taras/Documents/code/agent-swarm/src/slack/channel-join.ts:146`.
  Args: `channel`. Reads `resp.channel.is_ext_shared`, `resp.channel.is_pending_ext_shared`.
  Any throw is logged and treated as "not external".
- `conversations.join` — `channel-join.ts:189`. Args: `channel`. No response fields read.
  Handles `method_not_supported_for_channel_type` (private channel) with a human-invite error.
- `conversations.create` — `/Users/taras/Documents/code/agent-swarm/src/slack/channel-lifecycle.ts:241`.
  Args: `name` (normalized by `normalizeChannelName`, `channel-lifecycle.ts:218-232`: lowercase,
  non `[a-z0-9_-]` → `-`, trimmed, sliced to 80), `is_private`.
  Reads `result.channel.id`; throws `"Slack created the channel but did not return its ID."` when absent.
  Handles `name_taken` → `Slack channel name "<n>" is already taken.`
- `conversations.invite` — `channel-lifecycle.ts:269` (bulk, `users: userIds.join(",")`) and
  `channel-lifecycle.ts:282` (per-user retry). No response fields read.
  Handles `already_in_channel`: the bulk call falling over with that code triggers a per-user retry
  loop to work out whether *every* user was already a member (`alreadyInChannel` flag).
- `conversations.archive` — `channel-lifecycle.ts:300`. Args: `channel`. No response fields read.
  Handles `already_archived` (→ `alreadyArchived: true`), `cant_archive_general`, `cant_archive_required`.

Tool wrappers (`slack-create-channel.ts:59`, `slack-invite-to-channel.ts:59`,
`slack-archive-channel.ts:53`) additionally run `slackMissingScopeMessage(error)` and surface
`missing_scope` + `needed` to the agent.

---

## 11. `auth.test`

| # | Site | Args | Response read |
| --- | --- | --- | --- |
| 1 | `src/slack/handlers.ts:437` | `{}` | `user_id`, `bot_id` (cached in `cachedBotUserId` / `cachedBotId`) |
| 2 | `src/slack/assistant.ts:94` | `{}` | `user_id` |
| 3 | `src/slack/channel-activity.ts:63` | `{}` | `user_id` |
| 4 | `src/tools/slack-read.ts:189` | `{}` | `user_id` |
| 5 | `src/slack/render-v2.ts:678` (`slackTeamId`, via `apiCall`) | `{}` | **`team_id`** (module-level cache `cachedTeamId`) |

Call #1 is the load-bearing one: if it fails, `handlers.ts:493-498` skips the message entirely
("Bot user ID unavailable — skipping message to avoid silent misbehavior").

---

## 12. `users.info`

| # | Site | Args | Response read |
| --- | --- | --- | --- |
| 1 | `src/slack/enrich.ts:78` (`enrichSlackUserEmail`) | `user` | **`user.profile.email`**, `user.profile.real_name`, `user.real_name` |
| 2 | `src/tools/slack-read.ts:200` | `user` | `user.profile.display_name`, `user.real_name` |
| 3 | `src/tools/slack-list-channels.ts:108` | `user` (the DM peer) | `user.profile.display_name`, `user.real_name` |

`enrichSlackUserEmail` caches the result in KV under namespace `ENRICHMENT_NAMESPACE` for 24h and
**never caches a null/no-email result** (`enrich.ts:86-89`). On throw it logs and returns `null`
(`:81-84`). Downstream, `resolveSlackUserId` (`enrich.ts:125-166`) auto-links the Slack ID to a
canonical swarm user by email, or records it as unmapped.

`isUserAllowed` (`handlers.ts:99-134`) only calls this when `SLACK_ALLOWED_EMAIL_DOMAINS` filtering
is active. Note `handlers.ts:311-314` explicitly says the thread-context formatter makes **no**
`users.info` call.

`rewriteSlackMentions` (`enrich.ts:175-196`) performs **zero** Slack calls — pure DB reads.

---

## 13. `reactions.add` / `reactions.remove`

- `reactions.add` — `/Users/taras/Documents/code/agent-swarm/src/slack/ack.ts:29` (`ackSlackMessage`).
  Args: `channel`, `name`, `timestamp`. No response fields read.
  Handles `already_reacted` as a silent no-op (`ack.ts:31`); every other error is logged and swallowed.
  Emoji names used: `eyes`, `heavy_plus_sign`, `zap`, `speech_balloon`, `white_check_mark`, `x`.
- `reactions.add` — `/Users/taras/Documents/code/agent-swarm/src/slack/handlers.ts:540` (the `!now` path).
  Args: `channel`, `name: "zap"`, `timestamp`. Errors logged and swallowed.
- `reactions.remove` — `ack.ts:47` (`finalizeSlackMessageReaction`).
  Args: `channel`, `name`, `timestamp`. Loops over `["eyes","heavy_plus_sign","zap","speech_balloon"]`.
  Handles `no_reaction` and `message_not_found` by `continue`; other errors logged.
  Then calls `ackSlackMessage` with `white_check_mark` or `x` (`ack.ts:57`).

`finalizeTerminalSlackReactions` (`ack.ts:60-106`) fires these calls fire-and-forget (`void … .catch`).

---

## 14. `files.info`

`/Users/taras/Documents/code/agent-swarm/src/slack/files.ts:274` (`getFileInfo`).
Args: `file` (file ID). Reads `result.file` and maps:
`id`, `name`, `title`, `mimetype`, `filetype`, `size`, `url_private`, `url_private_download`,
`thumb_64`, `thumb_80`, `thumb_160`, `thumb_360`, `thumb_480`, `user`, `created`
(`files.ts:282-298`).
Every error is swallowed → returns `null` (`files.ts:299-301`). Caller
`slack-download-file.ts:88-91` maps `null` to `"File not found: <id>"`.

---

## 15. File upload — `client.filesUploadV2`

`/Users/taras/Documents/code/agent-swarm/src/slack/files.ts:92-166` (`uploadFile`).

Args built at `files.ts:121-136`:
- always: `file` (an absolute path string **or** a `Buffer`), `filename`, `title` (`title || filename`)
- when `channelId` is set: `channel_id`, and then optionally `thread_ts`, `initial_comment`

Size guard: `MAX_FILE_SIZE = 1073741824` (1 GB, `files.ts:9`). Checked twice —
`Buffer.length` at `files.ts:100` and `Bun.file(path).size` at `files.ts:111`, and a third time in
the tool at `slack-upload-file.ts:265` / `:280`.

Response fields consumed (`files.ts:142-146`) — **doubly nested**:

```ts
// result.files[0].files[0].id contains the actual file ID
// See: https://github.com/slackapi/node-slack-sdk/issues/1968
const uploadedFile = result.files?.[0] as { files?: { id?: string }[] } | undefined;
const fileId = uploadedFile?.files?.[0]?.id;
```

Missing id → `{ success:false, error:"Upload succeeded but no file ID returned" }`.
No Slack error code is inspected; the raw `error.message` is returned.

The SDK helper internally performs `files.getUploadURLExternal` → `POST <upload_url>` →
`files.completeUploadExternal` (library internals, covered by the SDK-behaviour researcher, but the
mock must implement all three because `filesUploadV2` is the only upload path agent-swarm uses).

Caller: `/Users/taras/Documents/code/agent-swarm/src/tools/slack-upload-file.ts:289-295`
(passes `file`, `filename`, `channelId`, `threadTs`, `initialComment`; reads `result.success`,
`result.fileId`, `result.error`).

---

## 16. `views.open`

`/Users/taras/Documents/code/agent-swarm/src/slack/actions.ts:34-60`.
Args: `trigger_id` (from `body.trigger_id`), `view` — a `modal` with `callback_id: "follow_up_submit"`,
`private_metadata: <taskId>`, `title`, `submit`, `close`, and one `input` block
(`block_id: "follow_up_input"`, element `plain_text_input` with `action_id: "follow_up_text"`, multiline).
No response fields read; errors logged only (`actions.ts:61-63`).

The matching `view_submission` handler is `actions.ts:67` and reads
`view.private_metadata` and `view.state.values.follow_up_input.follow_up_text.value`.

---

## 17. `assistant.threads.*`

- `assistant.threads.setStatus` — direct call at
  `/Users/taras/Documents/code/agent-swarm/src/slack/watcher.ts:437-441`.
  Args: `channel_id`, `thread_ts`, `status` (empty string clears it, `watcher.ts:410`).
  No response fields read; errors logged (`watcher.ts:442-444`).
  Invoked from `watcher.ts:403` (progress text) and `watcher.ts:410` (clear) and `watcher.ts:631`.
- Bolt-provided `setStatus` / `setTitle` — `/Users/taras/Documents/code/agent-swarm/src/slack/assistant.ts:62-75`.
  Both are wrapped in `safeSetStatus` / `safeSetTitle`, which swallow every error with a warning
  ("thread may not be an assistant thread"). Underlying methods:
  `assistant.threads.setStatus` and `assistant.threads.setTitle`.
  Call values: `"Queuing follow-up..."` (`:137`), `"Processing follow-up..."` (`:158`),
  `"Processing your request..."` (`:163`); title = first 47 chars of the message + `"..."` (`:166-171`).
- Bolt-provided `setSuggestedPrompts` — `assistant.ts:33-40`, called with
  `{ title: "Try these:", prompts: [ {title, message} × 3 ] }` →
  `assistant.threads.setSuggestedPrompts`.
- Bolt-provided `saveThreadContext` — `assistant.ts:26` and `assistant.ts:47` →
  `assistant.threads.setStatus`-adjacent context storage; Bolt's default implementation calls
  `assistant.threads.setStatus`-free `chat.*`-free `assistant.threads.*` context APIs backed by
  message metadata (library internals).
- Bolt-provided `getThreadContext` — `assistant.ts:174`. Reads `ctx.channel_id` only (`assistant.ts:176-178`).
- Bolt-provided `say` — `assistant.ts:30` and `assistant.ts:197` (both **only** on the
  `SLACK_RENDER_V2=false` path) → `chat.postMessage`.

---

## 18. Bolt `say()` and `respond()`

`say()` in the message handler (`chat.postMessage` under the hood, `thread_ts` explicit):
`handlers.ts:606`, `:619`, `:661`, `:672`, `:684`, `:852`, `:874`.
Every one of these is gated behind `!isSlackRenderV2Enabled()` except `handlers.ts:852`,
whose response `resp.ts` is read and stored via `registerTreeMessage` (`handlers.ts:860-868`).
Args used: `text`, `blocks`, `thread_ts`.

`respond()` in slash commands — `/Users/taras/Documents/code/agent-swarm/src/slack/commands.ts:33`
and `:98`. Both send `{ response_type: "ephemeral", blocks: [...] }`. Bolt posts these to the
command payload's **`response_url`**, not to a `chat.*` method.
Registered commands: `/agent-swarm-status` (`commands.ts:6`) and `/agent-swarm-help` (`commands.ts:61`).

---

## 19. Raw HTTP to Slack

### 19.1 File download — `src/slack/files.ts:199-203`

```ts
const downloadUrl = typeof file === "string" ? file : file.url_private_download;   // files.ts:179
…
const response = await fetch(downloadUrl, {
  headers: { Authorization: `Bearer ${token}` },
});
```

- URL field: **`url_private_download`** (never `url_private`, never a thumb URL).
- Header: `Authorization: Bearer <token>` only. No `Accept`, no user agent override.
- Failure check: `!response.ok` → `HTTP error <status>: <statusText>` (`files.ts:205-210`).
  `response.body === null` → `"No response body"`.
- The body is streamed to disk with `createWriteStream` (`files.ts:221-239`).
- **No content-type check and no size limit on download.** `MAX_FILE_SIZE` is upload-only.
  `isImageFile` (`files.ts:260-263`) only tests `mimetype.startsWith("image/")` and is **not called
  from any production path** (grep found no callers outside the module).
- Save path resolution (`files.ts:189-193`): when `file` is an object and `savePath` ends with `/`
  or has no `.`, the file's `name` is appended.
- `token` comes from `process.env.SLACK_BOT_TOKEN` at both call sites
  (`slack-read.ts:210`, `slack-download-file.ts:70`).
- Auto-download destination in `slack-read`: `AUTO_DOWNLOAD_DIR = "/app/shared/downloads/slack"`
  (`slack-read.ts:15`), file saved as `<dir>/<file.id>_<file.name>` (`slack-read.ts:272`).
  Failures are silently ignored (`slack-read.ts:282-284`).
- Default download dir for the tool:
  `DEFAULT_DOWNLOAD_DIR = "/workspace/shared/downloads/${AGENT_ID || "default"}/slack"` (`files.ts:14`).

### 19.2 Seed script — `src/be/seed-scripts/catalog/slack-thread-flatten.ts:52-60`

```ts
const url =
  "https://slack.com/api/conversations.replies?channel=" + encodeURIComponent(channelId) +
  "&ts=" + encodeURIComponent(threadTs) + "&limit=1000";
const res: any = await ctx.stdlib.fetchJson(url, { headers: { Authorization: "Bearer " + token } });
```

- **The base URL is hardcoded** to `https://slack.com/api/…`. There is no env override.
- Method: `GET` with query params (unlike every other call, which the SDK sends as POST form/JSON).
- Reads `res.ok`, `res.error`, `res.messages[]` → `username`, `user`, `bot_id`, `text`, `ts`,
  and `res.has_more` (`slack-thread-flatten.ts:61-82`).
- The token is resolved from the `SLACK_BOT_TOKEN` swarm config via
  `GET <mcpBaseUrl>/api/config/resolved?includeSecrets=true` (`slack-thread-flatten.ts:14-20`).

**Does the hardcoded URL matter for e2e?** Only if the e2e suite exercises this seed script.
It runs inside the scripts sandbox (`ctx.stdlib.fetchJson`), not through `WebClient`, so pointing
`slackApiUrl` at the mock will **not** redirect it. To cover this path the mock would need DNS/proxy
interception of `slack.com`, or the sandbox's `fetchJson` host allowlist would need a rewrite hook.
Everything else routes through the Bolt/`WebClient` `slackApiUrl`, which is settable.

---

## 20. Env knobs and named constants

| Name | Where | Real nature | Effect |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | `src/slack/app.ts:28`, `src/tools/slack-read.ts:210`, `src/tools/slack-download-file.ts:70`, seed script | env | Bot token for the `App` and for raw file downloads. Missing → Slack disabled. |
| `SLACK_APP_TOKEN` | `src/slack/app.ts:29` | env | Socket Mode app-level token (`xapp-`). Missing → Slack disabled. |
| `SLACK_DISABLE` | `src/slack/app.ts:22-26` | env | `"true"`/`"1"` → `initSlackApp` returns `null`. |
| `SLACK_RENDER_V2` | `src/slack/render-v2.ts:64-66` (`isEnvFlagEnabled("SLACK_RENDER_V2", false)`) | env flag, default off | **The big one.** On → the render-v2 pipeline (thread tree via `chat.postMessage` + `chat.update` with `metadata`, and outcome cards via `chat.startStream`/`chat.stopStream`/`chat.getPermalink`). Off → the legacy `say()` + tree-block pipeline in `handlers.ts`/`watcher.ts`/`responses.ts`. Every `say()` in `handlers.ts` and the greeting/offline `say()` in `assistant.ts` are suppressed when it is on. Also listed in `src/be/swarm-config-guard.ts:201`. |
| `SLACK_ALERTS_CHANNEL` | `src/queue-stall-alarm.ts:128`, `src/oauth/keepalive.ts:66`, `src/jira/webhook-lifecycle.ts:43` | env | Channel ID for operational alerts. `queue-stall-alarm` **throws** when unset; the other two warn and skip. |
| `SLACK_RENDER_METADATA_EVENT` | `src/slack/render-v2.ts:47` | **const, not env**: `"agent_swarm_render_v2"` | The `metadata.event_type` stamped on tree `chat.postMessage` (`:412`) and matched when reconciling a reservation from `conversations.replies` with `include_all_metadata:true` (`:340`). The payload carries `message_id` (the DB reservation id) and `kind: "tree"`. |
| `SLACK_MESSAGE_TS_PREFIX` | `src/be/db.ts:1670` | **const, not env**: `PENDING_SLACK_MESSAGE_TS_PREFIX = "pending:"` | Reserved-message rows get `ts = "pending:<id>"` (`db.ts:1775`) until `bindSlackMessageTimestamp` swaps in the real Slack ts. `isPendingSlackMessage` (`db.ts:1673`) tests the prefix. Never sent to Slack. |
| `SLACK_ATTACHMENTS_MAX` | `src/slack/blocks.ts:144` | **const, not env**: `20` | Caps the lines in the "Attachments (N):" mrkdwn block (`blocks.ts:172`). The count in the header stays the real total. |
| `SLACK_TREE_ATTACHMENT_BLOCKS_MAX` | `src/slack/blocks.ts:513` | **const, not env**: `10` | Caps how many completed nodes get their own attachment section in a tree message (`blocks.ts:562`); overflow becomes a `… and M more …` context block. Chosen to stay inside Slack's 50-block / 40 KB limits. |
| `SLACK_RETRIES` | — | **does not exist**; the real name is `MAX_SLACK_RETRIES = 3` at `src/slack/render-v2.ts:38` | Max rate-limit retries inside `callSlackWithRetry`. |
| `SLACK_HEADER` | — | **does not exist in `src/`**; only a test-local string at `src/tests/base-prompt.test.ts:519` (`"## Slack\n"`) | Marks the Slack section of the agent base prompt. Nothing to do with HTTP. |
| `SLACK_WEBHOOK_ACTOR` | `src/slack/enrich.ts:107` | **const, not env**: `{ kind: "system", id: "webhook:slack" }` | The `IdentityActor` recorded on audit events when `resolveSlackUserId` auto-creates or auto-links a user (`enrich.ts:142`, `:149`). Never sent to Slack. |
| `SLACK_ALLOWED_USER_IDS` / `SLACK_ALLOWED_EMAIL_DOMAINS` | `src/slack/handlers.ts` (`isUserAllowed`, `:99-134`) | env | When set, unknown senders are dropped. The email-domain branch is the only thing that forces a `users.info` call on the ingress path. |
| `SLACK_THREAD_STEERING` / `SLACK_THREAD_STEERING_MODE` | `src/slack/steering.ts:23`, `:46` | env | `"lead"`/`"all"` pick the steering target; mode `"steer"` vs default `"queue"`. Changes whether a thread reply creates a task or steers an existing one (and therefore which reaction is added). |
| `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` | `src/slack/handlers.ts:515-518` | env flag | When on, non-mention thread replies are not buffered. |
| `ADDITIVE_SLACK` | `src/slack/handlers.ts:514`, `src/slack/assistant.ts:16` | env flag | Enables thread buffering, the `!now` flush and the `zap` reaction. |
| `SLACK_BUFFER_MS` | thread-buffer config | env | Debounce window for the buffer flush. |
| `SLACK_DEV_SOCKET_MODE_OPT_IN` / `SLACK_ALLOW_DEV_SOCKET_MODE` | `src/slack/socket-mode-guard.ts`, used at `src/slack/app.ts:36-42` | env | Guard that refuses to open Socket Mode in dev unless explicitly opted in. **An e2e harness must satisfy this or `initSlackApp` returns `null` before any HTTP call happens.** |
| `SLACK_SIGNING_SECRET`, `SLACK_USER_TOKEN`, `SLACK_CLIENT_SECRET` | config/oauth | env | Not used on the Socket Mode outbound path. |
| `ENV=development` | `src/slack/responses.ts:41` | env | Prefixes every persona `username` with `(dev) `. |
| `AGENT_ID` | `src/slack/files.ts:14` | env | Part of `DEFAULT_DOWNLOAD_DIR`. |

Other hard limits the mock should tolerate:
`MAX_SECTION_LENGTH = 2900` (`src/slack/blocks.ts:13`),
`MAX_BLOCKS_PER_COMPLETION_MESSAGE = 45` (`blocks.ts:14`),
`MAX_INLINE_OUTPUT_BLOCKS_PER_MESSAGE = 10` (`responses.ts:45`),
`MAX_OUTCOME_MARKDOWN_LENGTH = 12_000` (`render-v2.ts:41`),
`MAX_TITLE_LENGTH = 72`, `MAX_TREE_NODE_LINE_LENGTH = 1_000`, `MAX_TREE_PREFIX_LENGTH = 120`,
`MAX_TREE_PROGRESS_LENGTH = 60` (`render-v2.ts:40-44`),
`TREE_UPDATE_DEBOUNCE_MS = 500`, `TREE_UPDATE_MIN_INTERVAL_MS = 3_000` (`render-v2.ts:36-37`).

---

## 21. mockRequirements — HTTP layer checklist

### Transport contract
1. Serve `POST /api/<method>` for every method below. Return **HTTP 200** with a JSON body
   `{ ok: true, … }` on success and `{ ok: false, error: "<slack_error_code>" }` on failure —
   `@slack/web-api` turns `ok:false` into an `Error` whose `.data` is the whole body, and
   agent-swarm reads `error.data.error` everywhere.
2. Accept both `application/x-www-form-urlencoded` and `application/json` bodies. The SDK picks
   form-encoding whenever a value is a primitive and JSON-stringifies `blocks`/`metadata`/`view`.
3. Honour a base-URL override so Bolt can be pointed at the mock (`slackApiUrl` on the `WebClient`).
   Bolt is built without an explicit `clientOptions` at `src/slack/app.ts:44`, so the harness must
   inject one (env `SLACK_API_URL` is read by `@slack/web-api` in recent versions) or patch the App.
4. Rate limiting: to exercise `callSlackWithRetry`, return `{ ok:false, error:"ratelimited" }` with
   HTTP **429** and a `Retry-After` header. Only render-v2 paths retry.
5. `missing_scope` responses must include a `needed` string field (`channel-join.ts:130`).

### Endpoints and the exact response fields agent-swarm reads

| Endpoint | Must return |
| --- | --- |
| `auth.test` | `ok`, `user_id`, `bot_id`, `team_id` |
| `chat.postMessage` | `ok`, `ts`, `channel` (`slack-start-thread.ts:85` reads `channel`). Must accept `channel`, `thread_ts`, `text`, `blocks`, `metadata`, `unfurl_links`, `unfurl_media`, `username`, `icon_emoji`. `username`/`icon_emoji` must be stored and rendered (persona override, `chat:write.customize`). |
| `chat.update` | `ok`, `ts` |
| `chat.delete` | `ok` |
| `chat.getPermalink` | `ok`, **`permalink`** (non-empty string, else render-v2 throws) |
| `chat.startStream` | `ok`, **`ts`**. Accept `channel`, `thread_ts`, `markdown_text`, `username`, `icon_emoji`, `recipient_user_id`, `recipient_team_id`. |
| `chat.stopStream` | `ok`. Accept `channel`, `ts`, `blocks`. Must be able to answer `message_not_in_streaming_state` on a second stop. |
| `conversations.replies` | `ok`, `messages[]` with `ts`, `text`, `user`, `bot_id`, `subtype`, `username`, `files[]`, `attachments[]`, `blocks[]`, and **`metadata.event_type` + `metadata.event_payload`** when `include_all_metadata=true`; plus `has_more` and `response_metadata.next_cursor`. Must honour `ts`, `limit`, `inclusive`, `oldest`, `cursor`. |
| `conversations.history` | `ok`, `messages[]` with `ts`, `text`, `user`, `bot_id`, `subtype`, `thread_ts`. Must honour `oldest` (inclusive) and `limit`. |
| `conversations.list` | `ok`, `channels[]` with `id`, `name`, `is_member`, `is_im`, `is_mpim`, `is_private`, `num_members`, `user`; plus `response_metadata.next_cursor`. Must honour `types`, `exclude_archived`, `limit`, `cursor`. **Cursor paging is required** — `fetchAllBotChannels` loops until `next_cursor` is empty. |
| `conversations.info` | `ok`, `channel.is_ext_shared`, `channel.is_pending_ext_shared` (both may be absent) |
| `conversations.join` | `ok`; support `method_not_supported_for_channel_type` for private channels |
| `conversations.create` | `ok`, **`channel.id`**; support `name_taken` |
| `conversations.invite` | `ok`; support `already_in_channel` |
| `conversations.archive` | `ok`; support `already_archived`, `cant_archive_general`, `cant_archive_required` |
| `users.info` | `ok`, `user.profile.email`, `user.profile.real_name`, `user.profile.display_name`, `user.real_name` |
| `reactions.add` | `ok`; support `already_reacted` |
| `reactions.remove` | `ok`; support `no_reaction`, `message_not_found` |
| `files.info` | `ok`, `file.{id,name,title,mimetype,filetype,size,url_private,url_private_download,thumb_64,thumb_80,thumb_160,thumb_360,thumb_480,user,created}` |
| `files.getUploadURLExternal` | `ok`, `upload_url`, `file_id` — required because `filesUploadV2` is the only upload path |
| `POST <upload_url>` (raw multipart) | HTTP 200 |
| `files.completeUploadExternal` | `ok`, **`files: [{ id, … }]`**. Note the SDK wraps this so the app sees `result.files[0].files[0].id` (`files.ts:142-146`). Must accept `channel_id`, `thread_ts`, `initial_comment`. |
| `views.open` | `ok` (the app reads nothing) |
| `assistant.threads.setStatus` | `ok`. Accept `channel_id`, `thread_ts`, `status` (including `""`). |
| `assistant.threads.setTitle` | `ok` |
| `assistant.threads.setSuggestedPrompts` | `ok`. Accept `channel_id`, `thread_ts`, `title`, `prompts[]`. |
| `apps.event.authorizations.list`, `auth.teams.list`, `apps.connections.open` | Bolt/Socket-Mode bootstrap. `apps.connections.open` must return `ok`, `url` pointing at the mock's WebSocket. |
| `POST <response_url>` on `hooks.slack.com` | Must be a mock-hosted URL that accepts `{ response_type, blocks }`, used by `/agent-swarm-status` and `/agent-swarm-help`. |

### File serving
- `files.info` and every message `files[]` entry must expose a **`url_private_download`** that the
  mock serves over plain `fetch()` with an `Authorization: Bearer <token>` header.
  agent-swarm never checks content-type or size on download, so any 200 with a body works;
  a non-200 surfaces as `HTTP error <status>: <statusText>`.
- `url_private` is only stored, never fetched. Thumb URLs are stored, never fetched.

### Error codes the mock must be able to emit on demand
`ratelimited` (+ `retry_after` / `Retry-After`), `message_not_found`, `channel_not_found`,
`thread_not_found`, `cant_update_message`, `edit_window_closed`, `cant_delete_message`,
`not_in_channel`, `method_not_supported_for_channel_type`, `already_in_channel`, `already_archived`,
`cant_archive_general`, `cant_archive_required`, `name_taken`, `already_reacted`, `no_reaction`,
`missing_scope` (with `needed`), `message_not_in_streaming_state`, `invalid_auth`.

### Behaviours the mock must model (not just endpoints)
- **Message metadata round-trip.** A `chat.postMessage` with `metadata.event_type =
  "agent_swarm_render_v2"` must be returned verbatim by `conversations.replies` when
  `include_all_metadata=true`; render-v2's crash-recovery reconciliation depends on it.
- **Streaming lifecycle.** `chat.startStream` creates a message in a "streaming" state;
  `chat.stopStream` finalizes it and a second stop must fail with `message_not_in_streaming_state`.
  `chat.update` on a streaming message must succeed (`render-v2.ts:806`).
- **Persona overrides.** `username` + `icon_emoji` on `chat.postMessage` must be reflected in
  `conversations.replies`/`history` results and in the HTML render, and such messages must carry a
  `bot_id` — `handlers.ts:445-452` explicitly notes that persona messages sometimes lack `bot_id`,
  which caused duplicate task creation.
- **`oldest` is inclusive** for both `conversations.history` and `conversations.replies`
  (`channel-activity.ts:93-94` skips the cursor message itself; `render-v2.ts:329` passes
  `inclusive: true`).
- **Permalinks must be stable and resolvable**, and must fail with `message_not_found` once the
  message is deleted — render-v2 uses `chat.getPermalink` as a liveness probe (`render-v2.ts:887`).
- **Socket Mode guard.** `getSlackSocketModeBlockReason` (`src/slack/socket-mode-guard.ts`, used at
  `src/slack/app.ts:36-42`) will refuse to connect in dev unless `SLACK_DEV_SOCKET_MODE_OPT_IN=true`.
  Set it in the e2e env or nothing outbound happens.
- **The hardcoded `https://slack.com/api/conversations.replies` in
  `src/be/seed-scripts/catalog/slack-thread-flatten.ts:53` is not redirectable** through the
  `WebClient` base-URL override. Either skip that script in e2e or add host interception.
