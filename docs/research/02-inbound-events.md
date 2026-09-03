# R2. Inbound surface: everything agent-swarm consumes from Slack

Scope: every Slack to bot payload that agent-swarm parses, the filters that drop or route it,
the Slack Web API calls each handler makes in response, and the timing the mock must honour.

All paths are absolute. All line numbers refer to the files as they exist at
`/Users/taras/Documents/code/agent-swarm` on 2026-09-03 (`@slack/bolt` 4.6.0,
`@slack/socket-mode` 2.0.5, `@slack/web-api` 7.13.0).

---

## 0. Wiring overview

### 0.1 App construction

`/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:44-49`

```ts
app = new App({
  token: botToken,          // SLACK_BOT_TOKEN
  appToken: appToken,       // SLACK_APP_TOKEN
  socketMode: true,
  logLevel: process.env.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
});
```

Registration order, `/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:52-62`:

1. `registerMessageHandler(app)` (`handlers.ts`)
2. `registerCommandHandler(app)` (`commands.ts`)
3. `registerActionHandlers(app)` (`actions.ts`)
4. `app.assistant(createAssistant())` (`assistant.ts`)

Startup preconditions that block the socket entirely:

* `SLACK_DISABLE=true|1` returns null (`app.ts:22-26`).
* Missing `SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN` returns null (`app.ts:28-34`).
* `NODE_ENV=development` blocks Socket Mode unless `SLACK_ALLOW_DEV_SOCKET_MODE=true`
  (`/Users/taras/Documents/code/agent-swarm/src/slack/socket-mode-guard.ts:5-10`, used at `app.ts:36-42`).
  The mock host must therefore run agent-swarm with `NODE_ENV` unset/production, or set
  `SLACK_ALLOW_DEV_SOCKET_MODE=true`.

`startSlackApp()` calls `await app.start()` then `startTaskWatcher()`
(`app.ts:67-82`).

### 0.2 Middleware vs listener chain (critical for the mock)

`app.assistant()` pushes a GLOBAL middleware, not a listener
(`/Users/taras/Documents/code/agent-swarm/node_modules/@slack/bolt/dist/App.js:258-262`).
`ignoreSelf` is pushed first, in the App constructor
(`node_modules/@slack/bolt/dist/App.js:194-195`).

Effective chain for every inbound payload:

```
ignoreSelf  ->  Assistant middleware  ->  [listeners: message, app_mention, commands, actions, view]
```

The Assistant middleware swallows the event (never calls `next()`) when it matches
(`node_modules/@slack/bolt/dist/Assistant.js:34-39`). Match rule
(`Assistant.js:95-109`):

```js
ASSISTANT_PAYLOAD_TYPES = { 'assistant_thread_started',
                            'assistant_thread_context_changed',
                            'message' }
// for 'message':
isThreadMessage      = 'channel' in payload && 'thread_ts' in payload
inAssistantContainer = payload.channel_type === 'im'
                       && (!('subtype' in payload)
                           || payload.subtype === 'file_share'
                           || payload.subtype === undefined)
```

Consequence the mock must respect: a `message` event with `channel_type: "im"` AND
`thread_ts` present AND (no subtype, or `subtype: "file_share"`) goes ONLY to
`assistant.userMessage`. `app.event("message")` in `handlers.ts` never sees it.
Drop `thread_ts` or set `channel_type: "channel"` and the same text reaches
`handlers.ts` instead. This is the single highest-value switch for driving the two
DM code paths.

Note: the comment at `/Users/taras/Documents/code/agent-swarm/src/slack/handlers.ts:504-506`
("file_share messages in DM assistant threads bypass the assistant handler and land here
instead") is stale for Bolt 4.6.0: `subtype === 'file_share'` is explicitly accepted by
`isAssistantMessage`. The `msg.assistant_thread` branch in `handlers.ts` is therefore
reachable only for DM `message` events WITHOUT `thread_ts` (or with a non-`im`
`channel_type`) that still carry an `assistant_thread` object. The mock should be able to
emit that shape because the production tests exercise it
(`/Users/taras/Documents/code/agent-swarm/src/tests/slack-assistant-comention-production.test.ts:277-338`).

### 0.3 Bolt's `ignoreSelf` (runs before everything)

`node_modules/@slack/bolt/dist/middleware/builtin.js:257-280`

* message events with `subtype === 'bot_message' && bot_id === context.botId` are dropped.
* any event with `event.user === context.botUserId` is dropped (except
  `member_joined_channel` / `member_left_channel`).

`context.botUserId` / `context.botId` come from Bolt's own `auth.test`
(`node_modules/@slack/bolt/dist/App.js:218-227, 817-828`). So the mock's `auth.test`
response is what defines "self" for this filter, before any agent-swarm code runs.

### 0.4 Socket Mode envelope shape

`node_modules/@slack/socket-mode/dist/src/SocketModeClient.js:283-330`.
The server sends one JSON text frame per delivery:

```jsonc
{
  "envelope_id": "<uuid>",
  "type": "events_api" | "slash_commands" | "interactive",
  "accepts_response_payload": false,
  "retry_attempt": 0,          // optional -> context.retryNum
  "retry_reason": "",          // optional -> context.retryReason
  "payload": { /* the Events API / command / interactivity body */ }
}
```

`payload` becomes Bolt's `body`. The client acks with
`{"envelope_id": "<same uuid>", "payload": {...}}`
(`SocketModeClient.js:342`). `hello` and `disconnect` frames are handled separately
(`SocketModeClient.js:282-291`).

### 0.5 Ack timing (what the mock must expect on the socket)

* Events API deliveries: Bolt acks the envelope BEFORE running any middleware or listener
  (`node_modules/@slack/bolt/dist/App.js:639-652`, `await ack()` in the `else` branch).
  The mock will see the envelope ack within a few milliseconds even when the handler then
  spends seconds doing DB and Slack API work.
* Commands, block_actions, view_submission: `listenerArgs.ack = ack` and the app must call
  it. Every agent-swarm handler calls `await ack()` as its first statement
  (`commands.ts:7`, `commands.ts:62`, `actions.ts:19`, `actions.ts:24`, `actions.ts:68`,
  `actions.ts:124`), so the ack still lands within milliseconds.
* `SocketModeResponseAck` has no 3-second auto-ack timer
  (`node_modules/@slack/bolt/dist/receivers/SocketModeResponseAck.js:13` explicitly notes the
  TODO). A second `ack()` call logs a warning and is ignored (lines 18-22).
* agent-swarm never reads `context.retryNum` / `context.retryReason`. Retry suppression is
  entirely `event_id`-based (see section 4).

---

## 1. Listener-by-listener payload contract

### 1.1 `app.event("message")` (`/Users/taras/Documents/code/agent-swarm/src/slack/handlers.ts:420-880`)

Destructured args: `{ event, body, client, say }` (line 420). Note `context` is NOT
destructured, so `context.botUserId` is unused; the handler resolves the bot identity itself.

The event is cast to a local `MessageEvent` interface
(`handlers.ts:136-147`):

```ts
interface MessageEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
  user?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  assistant_thread?: Record<string, unknown>;
}
```

#### Fields read

| Field | Line | Use |
|---|---|---|
| `body.event_id` | 423 | idempotency key for `wasEventSeen` |
| `event.subtype` | 432, 450 (via `isBotMessage`) | `message_changed` early return; `bot_message` drop |
| `event.bot_id` | 450 (via `isBotMessage`) | bot drop |
| `event.user` | 450, 457, 466, 475, 484, 533, 570, 604, 670, 752, 771 | bot self-check, required field, authz, identity resolution, buffering, rate limit, `slackUserId` |
| `event.text` | 453, 477, 490, 502, 589 | emptiness check, unmapped sample, effective text, mention detection, routing text |
| `event.files[]` | 454, 490 | `hasFiles`, `buildEffectiveText` |
| `event.channel` | 460, 481, 484, 523, 526, 533, 540, 566, 570, 591, 649, 654, 656, 728, 733, 750, 757, 768, 773, 862 | dedup key, buffer key, task `slackChannelId`, reactions, context key |
| `event.ts` | 460, 485, 533, 540, 570, 577, 608, 627, 632, 651, 656, 675, 693, 735, 759, 775, 855 | dedup key, `slackTriggerMessageTs`, reaction timestamp, `thread_ts` fallback |
| `event.thread_ts` | 486, 519, 523, 526, 553, 566, 590, 608, 627, 630, 675, 693, 698, 730, 855 | thread vs top-level branch, buffering, steering gate |
| `event.assistant_thread` | 509 | implicit-mention flag |

Never read: `event.client_msg_id`, `event.blocks`, `event.team`, `event.channel_type`,
`event.event_ts`, `body.team_id`, `body.api_app_id`, `body.authorizations`,
`body.event_time`, `body.token`, `context.*`. They may be present; they are ignored by
agent-swarm (Bolt itself reads `body.authorizations[0].is_enterprise_install`,
`node_modules/@slack/bolt/dist/helpers.js:106-111`).

#### Filter cascade, in exact order

1. `wasEventSeen(body.event_id)` true -> return (line 424-427).
2. `subtype === "message_changed"` -> return (line 432).
3. First-message-only `client.auth.test()` to fill `cachedBotUserId` / `cachedBotId`
   (lines 435-443).
4. `isBotMessage(msg, cachedBotUserId)` -> return (line 450). Definition at
   `handlers.ts:165-173`: true when `subtype === "bot_message"`, OR `bot_id` present, OR
   `user === cachedBotUserId`. Deliberately does NOT filter on `app_id`, `bot_profile`, or
   `username` (comment at lines 159-163).
5. `(!hasText && !hasFiles) || !msg.user` -> return (line 457). `hasText` requires
   `text.trim()` non-empty.
6. `isMessageProcessed(`${channel}:${ts}`)` -> return (line 461). In-memory `Set`, 60 s TTL
   (`handlers.ts:379-391`).
7. `isUserAllowed(client, msg.user)` false -> return (line 466). See section 6.
8. `resolveSlackUserId(client, msg.user, {sampleEventType:"message", sampleContext: msg.text ?? ""})`
   (line 475). May call `users.info`.
9. `workflowEventBus.emit("slack.message", {channel, text, user, ts, threadTs})` (line 481).
10. `effectiveText = buildEffectiveText(msg.text, msg.files)` (line 490).
11. `cachedBotUserId` still null -> return with an error log (line 493-498).
12. `botMentioned = msg.text?.includes(`<@${botUserId}>`)` (line 502). Original text only,
    not `effectiveText`.
13. `isImplicitMention = !!msg.assistant_thread && !botMentioned && !hasOtherUserMention(effectiveText, botUserId)`
    (lines 509-511).
14. `!now` branch: requires `ADDITIVE_SLACK` enabled AND `msg.thread_ts` AND
    stripped text starts with `!now` AND `hasSwarmThreadActivity(...)` (lines 519-547).
15. ADDITIVE buffer branch: `ADDITIVE_SLACK` AND `!botMentioned` AND `msg.thread_ts` AND
    NOT `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` (line 553). Inside: `hasOtherUserMention`
    -> return (554-559); `hasSwarmThreadActivity` false -> fall through to routing.
16. `routeMessage(routingText, botUserId, botMentioned || isImplicitMention, threadContext)`
    (line 593).
17. `matches.length === 0` and neither `botMentioned` nor `isImplicitMention` -> return
    (line 601).
18. Rate limit `checkRateLimit(msg.user)` (line 604 for the no-match path, line 670 for the
    matched path): 10 per user per 60 s (`handlers.ts:394-416`).
19. `extractTaskFromMessage` empty -> return with a nudge message (lines 617-625, 682-690).

#### Slack API calls made

| Call | Line | Condition |
|---|---|---|
| `client.auth.test()` | 437 | once per process, on first message event |
| `client.users.info({user})` | via `enrichSlackUserEmail`, `enrich.ts:78` | authz with `SLACK_ALLOWED_EMAIL_DOMAINS`, and identity cascade on kv miss |
| `client.conversations.replies({channel, ts, limit:1, inclusive:true})` | `handlers.ts:243-248` | `wasThreadStartedBySwarm`, cached per `channel:threadTs` |
| `client.conversations.replies({channel, ts, limit:20})` | `handlers.ts:296-300` | `getThreadContext`, only when `thread_ts` present |
| `client.reactions.add({channel, name:"zap", timestamp})` | 540 | `!now` path |
| `client.reactions.add` via `ackSlackMessage` | 577, 656, 740, 759, 775 | names `eyes`, `heavy_plus_sign`, `speech_balloon` |
| `say({text, thread_ts})` -> `chat.postMessage` | 606, 619, 661, 672, 684, 852, 874 | only when `SLACK_RENDER_V2` is off |
| `chat.postMessage` / `chat.update` via `ensureSlackThreadTree` | 659, 800 | only when `SLACK_RENDER_V2` is on (`render-v2.ts:403, 421, 552`) |

`say()` is built by Bolt from the event's conversation id
(`node_modules/@slack/bolt/dist/App.js:507-521, 627-629`), so the mock only needs
`chat.postMessage`.

#### Timing

The Events API envelope is already acked by Bolt before this handler starts (section 0.5).
The handler then awaits everything inline: `auth.test`, `users.info`, up to two
`conversations.replies`, `createTaskWithSiblingAwareness`, `reactions.add`, and one or more
`chat.postMessage`. A slow mock therefore does not cause Slack-side retries, but it does
serialize the handler. The mock should answer Web API calls in well under a second to keep
E2E runtimes sane.

---

### 1.2 `app.event("app_mention")` (`handlers.ts:883-887`)

```ts
app.event("app_mention", async ({ event }) => {
  console.log(`[Slack] App mentioned in channel ${event.channel}`);
});
```

Reads only `event.channel`. Makes no API calls, creates no tasks. It is a no-op logger:
the real work happens in the `message` listener, because Slack delivers BOTH
`app_mention` and `message` for a channel mention.

Mock implication: when the mock injects a channel @mention, it should deliver both events
(two separate envelopes with different `event_id`s), matching real Slack. Delivering only
`message` still exercises the full task path; delivering only `app_mention` does nothing.

---

### 1.3 `app.command("/agent-swarm-status")` (`/Users/taras/Documents/code/agent-swarm/src/slack/commands.ts:6-59`)

Destructured: `{ ack, respond }`. It reads NO field of the command payload, not
`command.text`, not `command.user_id`, not `command.channel_id`.

Bolt still requires the payload to be a well-formed command body: `getTypeAndConversation`
keys off `body.command !== undefined`
(`node_modules/@slack/bolt/dist/helpers.js:58-63`), and `matchCommandName` compares
`command.command` to the registered string
(`node_modules/@slack/bolt/dist/middleware/builtin.js:196-204`).
`respond()` exists only if `body.response_url` is set
(`node_modules/@slack/bolt/dist/App.js:631-634`), and it is an axios POST to that URL
(`buildRespondFn` in `App.js`).

Sequence:
1. `await ack()` (line 7) with no body.
2. `getAllAgents()`, `getAllTasks({status:"in_progress"})` (lines 9-10).
3. `await respond({response_type: "ephemeral", blocks: [header, section, divider, section]})`
   (lines 33-58).

### 1.4 `app.command("/agent-swarm-help")` (`commands.ts:61-102`)

Same shape. Reads no payload fields. Reads `ADDITIVE_SLACK` to decide whether to include an
extra help section (line 65). Calls `ack()` then `respond({response_type:"ephemeral", blocks})`
(lines 98-101).

Mock requirement for both: serve `POST <response_url>` and record the JSON body. The mock
must supply a `response_url` in the command payload or `respond` is undefined and the
handler throws.

---

### 1.5 `app.action("view_task_logs")` (`/Users/taras/Documents/code/agent-swarm/src/slack/actions.ts:18-20`)

`await ack()` only. No payload fields read, no API calls. It exists so Slack does not show
an error on a URL button.

Status: no code path currently emits a button with `action_id: "view_task_logs"`. The only
button produced by the Block Kit builders is `cancel_task`
(`/Users/taras/Documents/code/agent-swarm/src/slack/blocks.ts:121-136`; a repo-wide grep for
`type: "button"` in `blocks.ts`, `render-v2.ts`, `responses.ts` returns only that one).
The handler is vestigial but still registered, so the mock can drive it directly.

### 1.6 `app.action("follow_up_task")` (`actions.ts:23-64`)

Destructured: `{ ack, action, body, client }`.

Fields read:

* `action.type` must be `"button"` (line 26), otherwise silent return.
* `action.value` -> `taskId` (line 27). Falsy -> return.
* `body.trigger_id` (line 30, guarded by `"trigger_id" in body`). Missing -> return.

Sequence: `ack()` first (line 24), then `client.views.open({trigger_id, view})` (line 34).
The view is:

```jsonc
{
  "type": "modal",
  "callback_id": "follow_up_submit",
  "private_metadata": "<taskId>",
  "title":  {"type":"plain_text","text":"Follow-up"},
  "submit": {"type":"plain_text","text":"Send"},
  "close":  {"type":"plain_text","text":"Cancel"},
  "blocks": [{
    "type":"input",
    "block_id":"follow_up_input",
    "label":{"type":"plain_text","text":"Follow-up message"},
    "element":{
      "type":"plain_text_input",
      "action_id":"follow_up_text",
      "multiline":true,
      "placeholder":{"type":"plain_text","text":"What would you like the agent to do next?"}
    }
  }]
}
```

`views.open` failures are caught and logged (lines 61-63).

Also vestigial in terms of UI emission (no builder produces `action_id: "follow_up_task"`),
but fully functional when driven.

### 1.7 `app.view("follow_up_submit")` (`actions.ts:67-120`)

Destructured: `{ ack, view, body, client }`. Bolt sets `payload = body.view` and
`view = payload` (`node_modules/@slack/bolt/dist/App.js:531-533, 618-620`), and matches on
`body.view.callback_id` (`builtin.js:135-166`).

Fields read:

* `view.private_metadata` -> `taskId` (line 70). Falsy -> return.
* `view.state.values.follow_up_input.follow_up_text.value` -> follow-up text (line 71).
  Empty -> return.
* `view.callback_id` (line 83) as the unmapped-identity sample context.
* `body.user.id` (lines 81, 91) -> `slackUserId` and identity resolution.

Sequence:
1. `await ack()` with no body (line 68), which closes the modal.
2. `getTaskById(taskId)`; missing or no `slackChannelId` -> return (lines 75-76).
3. `getLeadAgent()`.
4. `resolveSlackUserId(client, body.user.id, {sampleEventType:"view_submission", sampleContext: view.callback_id})`
   (lines 81-84). May call `users.info`.
5. `createTaskWithSiblingAwareness(followUpText, {...parentTaskId: taskId, slackChannelId,
   slackThreadTs, slackUserId, requestedByUserId, contextKey})` (lines 85-99). Note the
   channel/thread are copied from the ORIGINAL task, not from the interaction payload.
6. If `SLACK_RENDER_V2` on: `ensureSlackThreadTree([task.id])` and return (lines 101-104).
   Otherwise `client.chat.postMessage({channel, thread_ts, text:"💬 Follow-up sent to *<agent>* (<link>)",
   unfurl_links:false, unfurl_media:false, username, icon_emoji})` (lines 109-116).

### 1.8 `app.action("cancel_task")` (`actions.ts:123-165`)

Destructured: `{ ack, action, client, body }`.

Fields read:

* `action.type === "button"` (line 126).
* `action.value` -> `taskId` (line 127).
* `body.message.ts` (line 148, guarded by `"message" in body`) -> the ts to `chat.update`.

Sequence:
1. `await ack()` (line 124).
2. `getTaskById(taskId)`; missing -> return.
3. `cancelTask(taskId, "Cancelled via Slack")`; returns falsy when already terminal -> return
   (lines 134-138).
4. If `task.slackChannelId && task.agentId`: `getAgentById`, `buildCancelledBlocks`, then
   `client.chat.update({channel: task.slackChannelId, ts: body.message.ts, text:"Task cancelled",
   unfurl_links:false, unfurl_media:false, blocks})` (lines 141-160).

Important: the channel used for `chat.update` comes from the TASK row, not from
`body.channel.id`. The `ts` comes from the interaction payload. The confirm dialog on the
button (`blocks.ts:128-133`) means real Slack sends the `block_actions` payload only after
the user confirms; the mock can send it directly.

---

### 1.9 Assistant: `threadStarted` (`/Users/taras/Documents/code/agent-swarm/src/slack/assistant.ts:24-44`)

Triggered by the `assistant_thread_started` event. Destructured:
`{ say, setSuggestedPrompts, saveThreadContext }`.

The handler reads no payload fields directly. Bolt's `extractThreadInfo`
(`node_modules/@slack/bolt/dist/Assistant.js:265-298`) requires
`payload.assistant_thread.channel_id` and `payload.assistant_thread.thread_ts` to be strings,
and optionally `payload.assistant_thread.context` (object). Missing either throws
`AssistantMissingPropertyError`.

Sequence:
1. `await saveThreadContext()` -> `DefaultThreadContextStore.save`
   (`node_modules/@slack/bolt/dist/AssistantThreadContextStore.js:30-61`), which calls
   `client.conversations.replies({channel, ts, oldest: ts, include_all_metadata: true, limit: 4})`
   and then, if it finds a message with `m.user === context.botUserId` and no `subtype`,
   `client.chat.update({channel, ts, text, blocks, metadata:{event_type:"assistant_thread_context", event_payload}})`.
2. If `SLACK_RENDER_V2` off: `say("Hi! I'm your Agent Swarm assistant. How can I help?")`
   (`assistant.ts:28-31`, template at `templates.ts:14-20`). Bolt's assistant `say` posts via
   `chat.postMessage` with `channel`/`thread_ts` filled in and a `metadata` block attached
   (`Assistant.js:191-208`).
3. `setSuggestedPrompts({title:"Try these:", prompts:[{title:"Check status", message:"What's the current status of all agents?"},
   {title:"Assign a task", message:"Can you help me with..."},
   {title:"List recent tasks", message:"Show me the most recent tasks"}]})`
   -> `assistant.threads.setSuggestedPrompts` (`Assistant.js:235-247`).

All errors are caught and logged (lines 41-43).

### 1.10 Assistant: `threadContextChanged` (`assistant.ts:46-48`)

`await saveThreadContext()`. Same two API calls as above
(`conversations.replies` + conditional `chat.update`). Triggered by
`assistant_thread_context_changed`.

### 1.11 Assistant: `userMessage` (`assistant.ts:50-218`)

Destructured: `{ message, body, say, setStatus, setTitle, getThreadContext, client }`.

Fields read:

| Field | Line | Use |
|---|---|---|
| `body.event_id` | 53 | `wasEventSeen` dedup |
| `message.thread_ts` (else `message.ts`) | 80 | `threadTs` |
| `message.channel` | 81 | `channelId` |
| `message.text` | 82 | task text, mention checks |
| `message.user` | 83 | `slackUserId`, identity |
| `message.ts` | 129, 148, 154, 187, 192, 207, 212 | `slackTriggerMessageTs`, reaction timestamp |

Filters:

1. `wasEventSeen(body.event_id)` -> return (53-57).
2. `client.auth.test()` once to cache `cachedBotUserId` (92-99); failure logs a warning and
   skips the mention check.
3. Co-mention guard: if the text does NOT contain `<@botUserId>` but DOES contain any other
   `<@U…>` token, return without creating a task (103-111,
   `hasOtherUserMention` at `/Users/taras/Documents/code/agent-swarm/src/slack/router.ts:14-17`).

Branching:

* `getAgentWorkingOnThread(channelId, threadTs)` returns a non-offline agent (124-126):
  * `ADDITIVE_SLACK` on -> `bufferThreadMessage(...)`, `ackSlackMessage(client, channelId,
    message.ts, count === 1 ? "eyes" : "heavy_plus_sign")`, `safeSetStatus("Queuing follow-up...")`,
    return (128-139).
  * otherwise -> `getMostRecentTaskInThread`, create a follow-up task with
    `parentTaskId`, `ackSlackMessage(..., "eyes")`, optional `ensureSlackThreadTree`,
    `safeSetStatus("Processing follow-up...")`, return (142-159).
* No working agent (162 onward):
  * `safeSetStatus("Processing your request...")` (163).
  * `safeSetTitle(<first 47 chars + "...">)` when text is non-empty (165-171).
  * `getThreadContext()` -> `DefaultThreadContextStore.get`
    (`AssistantThreadContextStore.js:7-29`, calls `conversations.replies` with
    `include_all_metadata: true, limit: 4`). If it returns `{channel_id: "C..."}` the task
    text gets `\n\n[User is viewing channel <#C...>]` appended (174-178).
  * `getLeadAgent()`; if null, create an unassigned task, `ackSlackMessage(..., "eyes")`, and
    either `ensureSlackThreadTree` or `say(<offline template>)` (180-200).
  * Otherwise create the task assigned to the lead, `ackSlackMessage(..., "eyes")`, optional
    `ensureSlackThreadTree` (202-213).

`setStatus` / `setTitle` are wrapped so `no_permission` and any other error is swallowed
(59-75). `setStatus` maps to `assistant.threads.setStatus`, `setTitle` to
`assistant.threads.setTitle` (`Assistant.js:213-260`).

Note: `renderedMessageText = await rewriteSlackMentions(messageText)`
(`assistant.ts:88`) is what becomes the task text. `rewriteSlackMentions`
(`/Users/taras/Documents/code/agent-swarm/src/slack/enrich.ts:175-196`) rewrites every
`<@U…>` to `<@U…|Name>` or `<@U…> (unknown user)` using pure DB reads. Zero Slack API calls.

---

## 2. Router and text extraction

`/Users/taras/Documents/code/agent-swarm/src/slack/router.ts`

`routeMessage(text, botUserId, botMentioned, threadContext?)`, lines 27-103:

1. `getAllAgents()` filtered to `status !== "offline"` (line 38).
2. `swarm#<36-char uuid>` regex `/swarm#([a-f0-9-]{36})/gi` -> exact agent by id, skipped
   when offline (41-49).
3. `/swarm#all/i` -> every non-lead online agent (52-59).
4. Thread follow-up (65-92): requires `matches.length === 0`, a `threadContext`, and either
   `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` off or `botMentioned` true. Bails if the text
   mentions another user and not the bot. Uses `getAgentWorkingOnThread`; if that agent is
   offline it falls back to the online lead.
5. Default: if still empty and `botMentioned`, the online lead (95-100).

`extractTaskFromMessage(text, botUserId)` (108-114) strips `<@botUserId>` globally,
`swarm#<uuid>`, `swarm#all`, then trims.

`hasOtherUserMention(text, botUserId)` (14-17) matches `/<@([A-Z0-9]+)>/g` and returns true
if any token is not the bot's.

`getAgentWorkingOnThread` (`/Users/taras/Documents/code/agent-swarm/src/be/db.ts:2776-2793`)
is the most recent `source='slack'` task for `(slackChannelId, slackThreadTs)` regardless of
status, resolved to its agent.

---

## 3. Message text extraction from thread history

`/Users/taras/Documents/code/agent-swarm/src/slack/message-text.ts:73-180`.
Used for `conversations.replies` results, not for the live event.

`extractSlackMessageText(msg)` collects and joins, in order:

* `msg.text` (trimmed).
* `msg.attachments[]`: `pretext`, `title` (rendered as `<title_link|title>` when
  `title_link` is set), `text`, `fallback` (deduped by exact string), then
  `fields[].title: value`, then `actions[].url` as `<url|text>`.
* `msg.blocks[]`: `section.text.text` and `section.fields[].text`; `rich_text` recursed via
  `collectRichTextParts` (handles `rich_text_section`, `rich_text_list`, `rich_text_quote`,
  `rich_text_preformatted` because it just walks `elements[]`); `header.text.text`;
  `context.elements[].text`; `actions.elements[]` as `<url|label>`.

Dedup rule: `msg.text` is omitted only when it appears as a complete trimmed LINE of the
combined body (lines 167-179).

`parseSlackTs(input)` (185-205) normalizes `1783411554.596189`, `p1783411554596189`, bare
digit runs, and full permalinks into the dotted form. The mock's permalinks should follow
`.../archives/<C…>/p<10 digits><6 digits>`.

---

## 4. Deduplication

Two independent layers plus one cross-restart guard.

### 4.1 `event_id` idempotency

`/Users/taras/Documents/code/agent-swarm/src/slack/event-dedup.ts`

* Key: `body.event_id` verbatim (line 91-94).
* TTL: 5 minutes (`DEFAULT_TTL_MS = 300_000`, line 24).
* Storage: in-memory `Map<string, number>` of expiry timestamps (lines 27-41).
* Sweep: `setInterval` every 60 s, `unref`'d so it does not hold the loop open (lines 51-64).
* Semantics: check-and-insert. First sighting inserts and returns `false`; sightings within
  the TTL return `true` (lines 71-81).
* Falsy `eventId` (null / undefined / empty) is a no-op returning `false` (line 92).
  A mock that omits `event_id` therefore disables dedup entirely.
* Single-pod only, explicitly documented (lines 20-22). No persistence, lost on restart.

Call sites: `handlers.ts:423-427` (message) and `assistant.ts:52-57` (userMessage).
NOT applied to `app_mention`, commands, block_actions, or view_submission.

### 4.2 `channel:ts` message dedup

`/Users/taras/Documents/code/agent-swarm/src/slack/handlers.ts:379-391`.
Key `${msg.channel}:${msg.ts}`. `Set` plus a `setTimeout` delete after 60 s
(`MESSAGE_DEDUP_TTL = 60_000`). Logs `[Slack] Duplicate event detected: <key>` on a hit and
`[Slack] Processing new message: <key>` on a miss. This catches re-deliveries carrying a
fresh `event_id` but the same message.

### 4.3 Slack retry metadata

Bolt exposes `context.retryNum` and `context.retryReason`
(`node_modules/@slack/bolt/dist/App.js:490-493`), fed by the envelope's `retry_attempt` and
`retry_reason` (`SocketModeClient.js:307-308`). agent-swarm never reads them. To test retry
suppression the mock must resend the SAME `event_id`, not just set `retry_attempt`.

### 4.4 Completion dedup (outbound side)

`/Users/taras/Documents/code/agent-swarm/src/slack/watcher.ts:513-519`: at watcher start
every already-completed Slack task is inserted into `notifiedCompletions`, so a restart does
not repost old results. `MIN_SEND_INTERVAL = 1000` ms throttles per-task sends (line 43).

---

## 5. Bot identity

Three independent caches, all populated by `auth.test`, none using `context.botUserId`.

| Location | Cached | Populated |
|---|---|---|
| Bolt internals | `context.botUserId`, `context.botId` | `client.auth.test({token})` at App init (`App.js:218-227`) when `tokenVerificationEnabled` (default true); otherwise lazily on first authorize (`App.js:830-845`) |
| `handlers.ts:186-191` | `cachedBotUserId` (= `auth.test().user_id`), `cachedBotId` (= `auth.test().bot_id`) | first `message` event (`handlers.ts:435-443`) |
| `assistant.ts:20` | `cachedBotUserId` | first assistant `userMessage` (`assistant.ts:92-99`) |
| `channel-activity.ts:13` | `cachedBotUserId` | first `fetchChannelActivity` call (`channel-activity.ts:62-65`) |

`resetSlackHandlerCachesForTesting()` (`handlers.ts:200-204`) clears the handler caches.

Self-recognition rules:

* `isBotMessage(event, botUserId)` (`handlers.ts:165-173`): `subtype === "bot_message"` OR
  `bot_id` present OR `user === botUserId`.
* `isSwarmThreadRoot(root, botUserId, botId)` (`handlers.ts:215-224`): matches OUR bot only.
  `root.user === botUserId` (normal posts) or `root.bot_id === botId` (persona posts made
  with `username` / `icon_emoji`, which carry `bot_id` but usually omit `user`).
* Thread-context formatting treats `m.user === botUserId || m.bot_id !== undefined ||
  m.subtype === "bot_message"` as an agent message and labels it `[Agent]:`
  (`handlers.ts:318-325`).
* Bolt's own `ignoreSelf` fires first (section 0.3).

Mock requirement: `auth.test` must return a stable `{ok:true, user_id, bot_id, team_id,
user, team, url}`. The `bot_id` returned here must equal the `bot_id` the mock stamps on
persona messages (`chat.postMessage` with `username` + `icon_emoji`), otherwise
`wasThreadStartedBySwarm` will not recognize swarm-started threads and the ADDITIVE_SLACK
root-author path will silently not fire.

---

## 6. User authorization and identity mapping

### 6.1 Allow-list

`/Users/taras/Documents/code/agent-swarm/src/slack/handlers.ts:29-40`. Both lists are parsed
at MODULE LOAD, so the env must be set before `import("./handlers")` runs (which happens in
`initSlackApp`, `app.ts:52`).

```ts
allowedEmailDomains = (SLACK_ALLOWED_EMAIL_DOMAINS || "").split(",").map(trim+lowercase).filter(Boolean)
allowedUserIds      = (SLACK_ALLOWED_USER_IDS      || "").split(",").map(trim).filter(Boolean)
filteringEnabled    = allowedEmailDomains.length > 0 || allowedUserIds.length > 0
```

`checkUserAccess` / `isUserAllowed` (lines 59-134):

1. Filtering disabled -> allow.
2. `allowedUserIds.includes(userId)` -> allow (no API call).
3. No domains configured -> deny.
4. `enrichSlackUserEmail(client, userId)` -> null -> deny.
5. Domain of the email not in the list -> deny.

### 6.2 Enrichment cache

`/Users/taras/Documents/code/agent-swarm/src/slack/enrich.ts:59-104`

* kv namespace `integration:user-enrichment:slack`, key = Slack user id, TTL 24 h.
* On miss: `client.users.info({user: slackUserId})`, reads
  `result.user.profile.email` and `result.user.profile.real_name ?? result.user.real_name`.
* Failures and no-email results are NEVER cached (lines 81-89).

### 6.3 Identity cascade

`/Users/taras/Documents/code/agent-swarm/src/slack/enrich.ts:125-166`
(`resolveSlackUserId`), called from `handlers.ts:475`, `assistant.ts:117`, `actions.ts:81`:

1. `findUserByExternalId("slack", slackUserId)` -> return `user.id`.
2. Miss -> `enrichSlackUserEmail`. With an email:
   `findOrCreateUserByEmail(email, {name}, {kind:"system", id:"webhook:slack"})`, then
   `linkIdentity(user.id, "slack", slackUserId, actor)`, then re-read the alias.
3. No email -> `recordUnmappedIdentity("slack", slackUserId, {sampleEventType, sampleContext})`
   (`/Users/taras/Documents/code/agent-swarm/src/be/unmapped-identities.ts:55-98`, two kv
   writes under `integration:unmapped:slack`, 30-day TTL, sample truncated to 100 chars) and
   return `undefined`. Task creation proceeds without `requestedByUserId`.

`sampleEventType` values the mock can expect to see recorded: `"message"`
(`handlers.ts:476`), `"assistant_message"` (`assistant.ts:118`), `"view_submission"`
(`actions.ts:82`).

`resolveIdentity` / `renderIdentity`
(`/Users/taras/Documents/code/agent-swarm/src/be/identity.ts:33-82`) are pure DB reads used
by `rewriteSlackMentions`.

---

## 7. Flows

### 7.1 Flow 1: channel @mention -> task -> ack reaction -> watcher posts result

Preconditions: bot is a member of `C_TEST`, one online lead agent exists,
`SLACK_ALLOWED_*` unset (or the user allowed), `ADDITIVE_SLACK` off,
`SLACK_RENDER_V2` off (the classic tree path), steering off.

1. Mock emits envelope `type: "events_api"` with an `event_callback` body containing
   `event.type = "message"`, `channel: "C_TEST"`, `user: "U_HUMAN"`, `ts: "<t1>"`,
   `text: "<@U_BOT> please do X"`, `channel_type: "channel"`, no `thread_ts`.
   Mock also emits a second envelope with `event.type = "app_mention"` (real Slack does).
2. Bolt acks both envelopes immediately.
3. `ignoreSelf` passes (`user !== botUserId`). Assistant middleware does not match
   (no `thread_ts`, `channel_type !== "im"`). The `message` listener runs.
4. `wasEventSeen(event_id)` false. `subtype` absent. `cachedBotUserId` null ->
   `client.auth.test()` (first event only).
5. `isBotMessage` false, `hasText` true, `user` present, `isMessageProcessed("C_TEST:<t1>")`
   false.
6. `isUserAllowed` -> true (no filtering) or one `users.info`.
7. `resolveSlackUserId` -> `findUserByExternalId` (DB) and possibly `users.info`.
8. `workflowEventBus.emit("slack.message", ...)`.
9. `botMentioned = true`. `additiveSlack` false, so both ADDITIVE branches are skipped.
10. `routeMessage("<@U_BOT> please do X", U_BOT, true, undefined)` -> `[lead]`
    (router.ts:95-100).
11. `checkRateLimit("U_HUMAN")` ok. `extractTaskFromMessage` -> `"please do X"`.
12. `threadTs = msg.ts` (no `thread_ts`). `getThreadContext` returns `""` immediately because
    `threadTs` (the event's `thread_ts`) is undefined (`handlers.ts:293`). No
    `conversations.replies` call on a top-level mention.
13. Lead branch (`agent.isLead`), `msg.thread_ts` undefined -> `steering = null`
    (`handlers.ts:730-738`).
14. `createTaskWithSiblingAwareness("please do X", {agentId, source:"slack",
    slackChannelId:"C_TEST", slackThreadTs:"<t1>", slackTriggerMessageTs:"<t1>",
    slackUserId:"U_HUMAN", parentTaskId: latestTask?.id, requestedByUserId,
    contextKey:"task:slack:C_TEST:<t1>"})`.
15. `ackSlackMessage(client, "C_TEST", "<t1>", "eyes")` -> `reactions.add({channel, name:"eyes",
    timestamp})`. `already_reacted` is swallowed (`ack.ts:31`).
16. `say({text:"Task assigned to: <Lead>", blocks: <tree>, thread_ts:"<t1>"})` ->
    `chat.postMessage`. The response `ts` is registered:
    `registerTreeMessage(taskId, "C_TEST", "<t1>", resp.ts)` -> also persists
    `slackProgressMessageTs` / `slackTreeRootMessageTs` (`watcher.ts:70-97`).
17. Watcher tick (default 3000 ms, `watcher.ts:507`, started at `app.ts:80`):
    `processTreeMessages()` re-renders and calls `chat.update` on `resp.ts` whenever the
    serialized blocks change (`watcher.ts:298-419`, `updateTreeMessage` ->
    `responses.ts:353-372`), throttled by `MIN_SEND_INTERVAL = 1000` ms.
18. On completion the tree renders its terminal state, then
    `finalizeTerminalSlackReactions` removes `eyes`, `heavy_plus_sign`, `zap`,
    `speech_balloon` and adds `white_check_mark` (all tasks completed) or `x`
    (`ack.ts:39-105`). For truncated output an extra inline reply is posted via
    `sendInlineTaskOutput` (`watcher.ts:322-335, 762-785`).
19. Non-tree fallback: `updateToFinal(task, tracked.messageTs)` -> `chat.update`, or
    `sendTaskResponse(task)` -> `chat.postMessage` with `username` + `icon_emoji`
    (`watcher.ts:791-804`, `responses.ts:117-190, 387-415`).

Mock must serve: `auth.test`, `users.info`, `reactions.add`, `reactions.remove`,
`chat.postMessage`, `chat.update`.

### 7.2 Flow 2: thread follow-up

Three sub-cases.

**(a) Follow-up WITH mention, `ADDITIVE_SLACK` off.**
Event has `thread_ts: "<t1>"`, `ts: "<t2>"`, `text: "<@U_BOT> also do Y"`.
Step 12 differs: `getThreadContext` now runs and calls
`client.conversations.replies({channel, ts:"<t1>", limit:20})` (`handlers.ts:296-300`).
It filters out the current `ts`, keeps anything with extractable text, labels bot messages
`[Agent]:` and humans `<@U…>:`, then `rewriteSlackMentions`. The result is wrapped by the
`slack.message.thread_context` template (`templates.ts:42-55`) as
`<thread_context>…</thread_context>` and prefixed to the task description
(`handlers.ts:636-643, 704-711`).
Routing: `routeMessage(text, botUserId, true, {channelId, threadTs})` hits the thread
follow-up branch (router.ts:65-92) and routes to the agent already working the thread.
Reaction: `eyes`. Task carries `slackThreadTs = "<t1>"`, `slackTriggerMessageTs = "<t2>"`.

**(b) Follow-up WITHOUT mention, `ADDITIVE_SLACK` off, `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` off.**
The ADDITIVE branch at `handlers.ts:553` is skipped (flag off). `routeMessage` is called
with `botMentioned = false` and a `threadContext`, so the thread follow-up branch still fires
and routes to the working agent (router.ts:65). Task created, `eyes` reaction.

**(c) Follow-up WITHOUT mention, `ADDITIVE_SLACK=true`.**
`handlers.ts:553-586`:
* If the text mentions another user (`<@U_OTHER>`) and not the bot -> return, nothing
  buffered (554-559).
* `hasSwarmThreadActivity(client, channel, thread_ts)` (`handlers.ts:270-279`) is
  `getAgentWorkingOnThread(...) !== null || wasThreadStartedBySwarm(...)`.
  `wasThreadStartedBySwarm` calls
  `conversations.replies({channel, ts: thread_ts, limit:1, inclusive:true})` once per thread
  and caches the boolean in a 1000-entry insertion-ordered Map (`handlers.ts:232-262`).
* On activity: `bufferThreadMessage(channel, thread_ts, effectiveText, user, ts)`, then
  `ackSlackMessage` with `eyes` on the first buffered message and `heavy_plus_sign` on
  appends (`handlers.ts:570-582`). Return. No task yet.
* Debounce: `ADDITIVE_SLACK_BUFFER_MS`, default 10000 ms, reset on every append
  (`thread-buffer.ts:27`, `additive-buffer.ts:106-126`).
* On flush (`thread-buffer.ts:130-266`):
  1. Join texts with `\n---\n`, `rewriteSlackMentions`, prefix
     `[Thread follow-up — N message(s) buffered]`.
  2. `getLatestActiveTaskInThread` for dependency chaining.
  3. `requestSlackThreadSteering(...)`; if it returns a result, post an ack message and
     return without creating a task (169-195).
  4. Otherwise `getThreadContextForBuffer` -> `conversations.replies({channel, ts, limit:20})`,
     wrap in `<thread_context>`.
  5. `createTaskWithSiblingAwareness(fullDescription, {agentId: lead?.id, source:"slack",
     slackChannelId, slackThreadTs, slackTriggerMessageTs: <ts of LAST buffered message>,
     slackUserId: <userId of FIRST buffered message>, dependsOn: immediate ? undefined :
     [latestActiveTask.id], parentTaskId: mostRecentTask?.id, contextKey})`.
  6. `SLACK_RENDER_V2` off -> `chat.postMessage` with `buildBufferFlushBlocks` and persona
     `username`/`icon_emoji`, then `registerTreeMessage` on the returned `ts`.

**`SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION=true`** disables both (b) and (c): the ADDITIVE
branch is gated off (`handlers.ts:553`) and `routeMessage` skips the thread follow-up branch
unless `botMentioned` (`router.ts:65`). Non-mention thread replies are silently dropped.
DM assistant threads are unaffected because they never reach this code.

**`!now`** (`handlers.ts:519-547`): strips all `<@U…>` tokens, requires the remainder to start
with `!now`, requires `hasSwarmThreadActivity`. Appends the trailing text (if any) to the
buffer, calls `instantFlush(threadKey)` (which flushes with `immediate = true`, so no
`dependsOn`), then `client.reactions.add({channel, name:"zap", timestamp})` directly (not via
`ackSlackMessage`), and returns.

### 7.3 Flow 3: DM / assistant thread

**assistant_thread_started.**
1. Mock emits `events_api` envelope, `event.type = "assistant_thread_started"`,
   `event.assistant_thread = {user_id, context:{channel_id?, team_id?, enterprise_id?},
   channel_id:"D_TEST", thread_ts:"<t0>"}`.
2. Bolt acks. Assistant middleware matches on type. `threadStarted` runs.
3. `saveThreadContext()` -> `conversations.replies({channel:"D_TEST", ts:"<t0>", oldest:"<t0>",
   include_all_metadata:true, limit:4})`, then `chat.update` on the first message authored by
   `context.botUserId` with `metadata.event_type = "assistant_thread_context"`.
4. `say("Hi! I'm your Agent Swarm assistant. How can I help?")` -> `chat.postMessage`
   (with `metadata` attached by Bolt) when `SLACK_RENDER_V2` is off.
5. `assistant.threads.setSuggestedPrompts({channel_id, thread_ts, title, prompts})`.

**assistant_thread_context_changed.** Same envelope with
`event.type = "assistant_thread_context_changed"` and an updated
`assistant_thread.context`. Runs `saveThreadContext()` only.

**User message in the assistant thread.**
1. Mock emits `event.type = "message"`, `channel:"D_TEST"`, `channel_type:"im"`,
   `thread_ts:"<t0>"`, `ts:"<t1>"`, `user:"U_HUMAN"`, `text:"do X"`. No `subtype`
   (or `subtype:"file_share"` with `files[]`).
2. Assistant middleware matches -> `userMessage` runs, `handlers.ts` never sees it.
3. `wasEventSeen(body.event_id)`; `auth.test` once; co-mention guard.
4. `resolveSlackUserId(..., sampleEventType:"assistant_message")`.
5. First message in the thread (no working agent):
   `setStatus("Processing your request...")`, `setTitle(<truncated text>)`,
   `getThreadContext()` -> `conversations.replies(..., include_all_metadata:true, limit:4)`,
   `getLeadAgent()`, create task, `reactions.add({name:"eyes"})`,
   optional `ensureSlackThreadTree`.
6. Watcher: because `channelId.startsWith("D")` the watcher treats it as a DM
   (`watcher.ts:425-427`). It posts an initial tree message via
   `chat.postMessage` (`postInitialDMTreeMessage`, `watcher.ts:452-502`), registers it, and
   calls `assistant.threads.setStatus({channel_id, thread_ts, status})` on every tick while
   in progress, then `setStatus` with an empty string when terminal
   (`watcher.ts:396-413, 432-445`).

**Plain DM outside an assistant thread** (no `thread_ts`): the Assistant middleware does not
match, so `handlers.ts` handles it exactly like a channel message except
`channel` starts with `D`.

### 7.4 Flow 4: slash commands

1. Mock emits envelope `type: "slash_commands"` with `payload` = the classic command body.
2. Bolt sets `type = Command` because `body.command` is defined, `payload = body`,
   `command = payload`, `respond = POST body.response_url`.
3. `matchCommandName` compares `body.command` to `"/agent-swarm-status"` or
   `"/agent-swarm-help"`.
4. Handler calls `ack()` (empty), does DB reads, then `respond({response_type:"ephemeral",
   blocks:[...]})`.
5. The mock must accept `POST <response_url>` with a JSON body and return 200. The posted
   payload is ephemeral, so it is not a channel message; the mock should store it as an
   ephemeral record keyed by the command invocation.

### 7.5 Flow 5: button clicks and modal

**follow_up_task -> views.open -> view_submission.**
1. Mock emits envelope `type: "interactive"` with a `block_actions` payload whose
   `actions[0] = {type:"button", action_id:"follow_up_task", block_id:"…", value:"<taskId>",
   action_ts:"…"}` and a top-level `trigger_id`.
2. `ack()`, then `client.views.open({trigger_id, view})`. The mock must return
   `{ok:true, view:{id:"V…", hash:"…", …}}` and remember the view (id, callback_id,
   private_metadata, blocks).
3. Mock then emits a `view_submission` payload with
   `view.callback_id = "follow_up_submit"`, `view.private_metadata = "<taskId>"`,
   `view.state.values.follow_up_input.follow_up_text = {type:"plain_text_input", value:"<text>"}`,
   and `user.id`.
4. Handler acks (closing the modal), resolves identity, creates the follow-up task with
   `parentTaskId = <taskId>` and the ORIGINAL task's channel/thread, then either
   `ensureSlackThreadTree` or `chat.postMessage` in that thread.

**cancel_task.**
1. Mock emits `block_actions` with `actions[0] = {type:"button", action_id:"cancel_task",
   value:"<taskId>"}` and `message: {ts:"<messageTs>", …}`.
2. Handler acks, cancels in DB, then `chat.update({channel: task.slackChannelId,
   ts:"<messageTs>", text:"Task cancelled", blocks: <cancelled blocks>})`.
   If the task is already terminal, `cancelTask` returns falsy and nothing is updated.

**view_task_logs.** `ack()` only.

### 7.6 Flow 6: file attached to a message

1. Mock emits `event.type = "message"` with `subtype: "file_share"` (real Slack sets this),
   `text` optional, and `files: [{id, name, title, mimetype, filetype, size, url_private,
   url_private_download, thumb_*, user, created}]` (shape at
   `/Users/taras/Documents/code/agent-swarm/src/slack/files.ts:19-35`).
2. `handlers.ts` is reached only when the message is NOT an assistant-thread DM (see 0.2).
   `hasFiles` is true, so an empty `text` is still accepted (line 457).
3. `buildEffectiveText` (`handlers.ts:365-376`) produces
   `"<text>\n\n[File: report.pdf (application/pdf, 1.2 MB) id=F0123]"` using
   `buildAttachmentText` (353-357) and `formatFileSize` (342-347: B / KB / MB / GB with one
   decimal).
4. That string is what routing, the mention checks, and the task description see. The handler
   does NOT download anything and does NOT call `files.info`.
5. Download happens later, agent-driven, through the tools
   `/Users/taras/Documents/code/agent-swarm/src/tools/slack-download-file.ts` (calls
   `getFileInfo` -> `files.info`, then `downloadFile`) and
   `/Users/taras/Documents/code/agent-swarm/src/tools/slack-read.ts`.
   `downloadFile` (`files.ts:174-252`) does a plain `fetch(url_private_download, {headers:{Authorization: "Bearer <token>"}})`
   and streams to disk. Default directory
   `/workspace/shared/downloads/${AGENT_ID || "default"}/slack` (`files.ts:14`).

Mock requirement: `url_private_download` must be an HTTP URL the mock serves, and it must
accept `Authorization: Bearer <bot token>` and return the bytes. `files.info` must return the
same field set.

### 7.7 Flow 7: steering (`SLACK_THREAD_STEERING`)

`/Users/taras/Documents/code/agent-swarm/src/slack/steering.ts`

Gates:
* `isSteeringEnabled()` requires `STEERING_ENABLED=true|1`
  (`/Users/taras/Documents/code/agent-swarm/src/utils/steering-enabled.ts`).
* `SLACK_THREAD_STEERING` selects the target: `"lead"` -> `getLatestLeadTaskInThread`,
  `"all"` -> `getLatestActiveTaskInThread`, anything else -> `null` (steering.ts:19-31).
* The target must have `status === "in_progress"` (line 44).
* `SLACK_THREAD_STEERING_MODE` is `"steer"` or (default) `"queue"` (line 46).

Two entry points:

* Direct mention on a lead in a thread: `handlers.ts:729-746`. Only when
  `agent.isLead` AND `msg.thread_ts` is set. On success it adds a `speech_balloon` reaction
  (`ackSlackMessage`, line 740), pushes into `results.steered`, and `continue`s (no task).
  When `SLACK_RENDER_V2` is off, a `say()` message
  `"<ack> *<agent>* will receive it."` is posted at the end (`handlers.ts:872-879`).
* Buffer flush: `thread-buffer.ts:163-195`. On success it posts the ack text via
  `chat.postMessage` with persona and returns without creating a task.

Side effect: for every `messageTimestamps` entry a log row is written with
`eventType: "task_steering"`, `newValue: "slack_reaction"`,
`metadata: {slackChannelId, slackMessageTs}` (steering.ts:56-63). The watcher later reads
those rows to replace the `speech_balloon` with the terminal reaction
(`ack.ts:93-105`).

Ack strings (`steering.ts:69-79`), all wrapped in `:speech_balloon: _…_`:
`"Your message was queued as a follow-up task."` (promoted),
`"Interrupt steering is unavailable for this task, so your message was queued."` (degraded),
`"Your steering message was sent to the active task."` (steered),
`"Your steering message was queued for the active task."` (queued).

### 7.8 Flow 8: message edits and deletes

* `subtype === "message_changed"`: explicit early return, first thing after the dedup check
  (`handlers.ts:432`). Nothing else is inspected.
* `subtype === "message_deleted"`: not named anywhere. It carries no `user` and no top-level
  `text`, so the guard at `handlers.ts:457` (`(!hasText && !hasFiles) || !msg.user`) drops it.
* No `reaction_added` / `reaction_removed` listener exists, and the manifest does not
  subscribe to them (`/Users/taras/Documents/code/agent-swarm/slack-manifest.json`
  `bot_events`: `app_mention`, `message.channels`, `message.groups`, `message.im`,
  `assistant_thread_started`).
* `assistant_thread_context_changed` is handled by Bolt's Assistant even though the manifest
  does not list it. If the mock emits it, the handler runs.

Caution for the mock: `subtype: "channel_join"` messages DO carry a `user` and a `text`
("<@U…> has joined the channel"), so they survive the guard at line 457 and reach
`routeMessage`. With no bot mention and no thread they produce no match and are dropped at
line 601. Inside a thread with `ADDITIVE_SLACK=true` they would be buffered. Emit them
deliberately, not incidentally.

---

## 8. Env knobs that change inbound behaviour

| Variable | Read at | Effect |
|---|---|---|
| `SLACK_BOT_TOKEN` | `app.ts:28` | required; also the bearer for file downloads |
| `SLACK_APP_TOKEN` | `app.ts:29` | required; Socket Mode `apps.connections.open` token |
| `SLACK_DISABLE` | `app.ts:22` | `true`/`1` disables the whole integration |
| `NODE_ENV` | `socket-mode-guard.ts:6`, `app.ts:48` | `development` blocks Socket Mode unless opted in; also sets Bolt `LogLevel.DEBUG` |
| `SLACK_ALLOW_DEV_SOCKET_MODE` | `socket-mode-guard.ts:7` | opt-in override for the above |
| `SLACK_ALLOWED_USER_IDS` | `handlers.ts:35` (module load) | comma list; whitelisted ids skip the email lookup |
| `SLACK_ALLOWED_EMAIL_DOMAINS` | `handlers.ts:30` (module load) | comma list of lowercase domains; triggers `users.info` |
| `ADDITIVE_SLACK` | `handlers.ts:514`, `assistant.ts:16`, `commands.ts:65` (per call) | enables non-mention thread buffering, `!now`, and the assistant buffering branch |
| `ADDITIVE_SLACK_BUFFER_MS` | `thread-buffer.ts:27` (module load) | debounce window, default 10000 |
| `SLACK_THREAD_FOLLOWUP_REQUIRE_MENTION` | `handlers.ts:515`, `router.ts:34` (per call) | drops non-mention thread replies |
| `SLACK_THREAD_STEERING` | `steering.ts:23` (per call) | `off` (default) / `lead` / `all` |
| `SLACK_THREAD_STEERING_MODE` | `steering.ts:46` | `queue` (default) / `steer` |
| `STEERING_ENABLED` | `utils/steering-enabled.ts` | master switch for steering |
| `SLACK_RENDER_V2` | `render-v2.ts:65` (per call) | swaps every `say()`/tree post for the v2 thread-tree renderer; suppresses the plain-text nudges |

`isEnvFlagEnabled` (`/Users/taras/Documents/code/agent-swarm/src/utils/env-flag.ts:26-56`)
accepts `true`/`1` as truthy and `false`/`0` as falsy, case-insensitive and trimmed;
anything else falls back to the default.

---

## 9. Mock requirements

### 9.1 Socket Mode frames the mock must send

Connection handshake, in order:

1. Serve `POST /api/apps.connections.open` returning `{ok:true, url:"ws://<host>/link?ticket=…"}`.
2. On WebSocket open, send `{"type":"hello","num_connections":1,"debug_info":{…},
   "connection_info":{"app_id":"A_MOCK"}}`.
3. Expect `{"envelope_id":"…","payload":{…}}` acks back for every envelope sent.
4. Optionally send `{"type":"disconnect","reason":"warning"}` to force a reconnect test.

### 9.2 Payload templates

**Channel message (`events_api`)**

```jsonc
{
  "envelope_id": "e1",
  "type": "events_api",
  "accepts_response_payload": false,
  "retry_attempt": 0,
  "retry_reason": "",
  "payload": {
    "token": "verification-token",
    "team_id": "T_MOCK",
    "api_app_id": "A_MOCK",
    "event": {
      "type": "message",
      "client_msg_id": "<uuid>",
      "text": "<@U_BOT> please do X",
      "user": "U_HUMAN",
      "ts": "1900000000.000100",
      "team": "T_MOCK",
      "channel": "C_TEST",
      "channel_type": "channel",
      "event_ts": "1900000000.000100",
      "blocks": [ /* rich_text; ignored by the message handler */ ]
    },
    "type": "event_callback",
    "event_id": "Ev0000000001",
    "event_time": 1900000000,
    "authorizations": [{
      "enterprise_id": null, "team_id": "T_MOCK", "user_id": "U_BOT",
      "is_bot": true, "is_enterprise_install": false
    }],
    "is_ext_shared_channel": false,
    "event_context": "1-message-T_MOCK-C_TEST"
  }
}
```

Required by agent-swarm: `event.type`, `event.channel`, `event.ts`, `event.user`,
`event.text` (or `event.files`), and `event_id`.
Required by Bolt: `event` (to classify as an Event), and `authorizations[0]` or
`is_enterprise_install` for the enterprise flag (defaults to false when absent).
`channel_type` matters only for the Assistant match.

**Thread reply.** Same, plus `"thread_ts": "1900000000.000100"` and a later `ts`.

**app_mention.** Same envelope with `event.type = "app_mention"`, a distinct `event_id`, and
no `thread_ts` unless the mention was in a thread.

**file_share message.**

```jsonc
"event": {
  "type": "message",
  "subtype": "file_share",
  "text": "here you go",
  "user": "U_HUMAN",
  "ts": "1900000000.000300",
  "channel": "C_TEST",
  "channel_type": "channel",
  "files": [{
    "id": "F0MOCK001",
    "name": "report.pdf",
    "title": "report.pdf",
    "mimetype": "application/pdf",
    "filetype": "pdf",
    "size": 1258291,
    "url_private": "http://<mock>/files/F0MOCK001/report.pdf",
    "url_private_download": "http://<mock>/files/F0MOCK001/download/report.pdf",
    "user": "U_HUMAN",
    "created": 1900000000
  }]
}
```

**assistant_thread_started.**

```jsonc
"event": {
  "type": "assistant_thread_started",
  "assistant_thread": {
    "user_id": "U_HUMAN",
    "context": {"channel_id": "C_TEST", "team_id": "T_MOCK", "enterprise_id": null},
    "channel_id": "D_TEST",
    "thread_ts": "1900000000.000001"
  },
  "event_ts": "1900000000.000002"
}
```

`assistant_thread.channel_id` and `assistant_thread.thread_ts` MUST be strings or Bolt throws
`AssistantMissingPropertyError`.

**assistant_thread_context_changed.** Identical shape, type
`"assistant_thread_context_changed"`, with a changed `assistant_thread.context`.

**Assistant user message.**

```jsonc
"event": {
  "type": "message",
  "channel": "D_TEST",
  "channel_type": "im",
  "thread_ts": "1900000000.000001",
  "ts": "1900000000.000010",
  "user": "U_HUMAN",
  "text": "do X",
  "event_ts": "1900000000.000010"
}
```

Omit `subtype` entirely (or use `"file_share"`). Any other subtype sends it to
`handlers.ts` instead.

**Handler-path DM with `assistant_thread`** (exercises the `isImplicitMention` branch):
same as a plain DM message with `channel: "D_TEST"`, NO `thread_ts`, plus
`"assistant_thread": {"channel_id": "D_TEST"}`.

**Slash command (`slash_commands`)**

```jsonc
{
  "envelope_id": "e2",
  "type": "slash_commands",
  "accepts_response_payload": true,
  "payload": {
    "token": "verification-token",
    "team_id": "T_MOCK",
    "team_domain": "mock",
    "channel_id": "C_TEST",
    "channel_name": "general",
    "user_id": "U_HUMAN",
    "user_name": "human",
    "command": "/agent-swarm-status",
    "text": "",
    "api_app_id": "A_MOCK",
    "is_enterprise_install": "false",
    "response_url": "http://<mock>/api/response_url/<opaque>",
    "trigger_id": "1900000000.000000.abcdef"
  }
}
```

`command` and `response_url` are mandatory. `channel_id` is used only for `say()`.

**Block actions (`interactive`)**

```jsonc
{
  "envelope_id": "e3",
  "type": "interactive",
  "accepts_response_payload": false,
  "payload": {
    "type": "block_actions",
    "user": {"id": "U_HUMAN", "username": "human", "team_id": "T_MOCK"},
    "api_app_id": "A_MOCK",
    "token": "verification-token",
    "container": {
      "type": "message", "message_ts": "1900000000.000200",
      "channel_id": "C_TEST", "is_ephemeral": false, "thread_ts": "1900000000.000100"
    },
    "trigger_id": "1900000000.000200.abcdef",
    "team": {"id": "T_MOCK", "domain": "mock"},
    "enterprise": null,
    "is_enterprise_install": false,
    "channel": {"id": "C_TEST", "name": "general"},
    "message": {
      "type": "message", "subtype": "bot_message", "ts": "1900000000.000200",
      "bot_id": "B_MOCK", "text": "…", "blocks": [ … ]
    },
    "state": {"values": {}},
    "response_url": "http://<mock>/api/response_url/<opaque>",
    "actions": [{
      "type": "button",
      "action_id": "cancel_task",
      "block_id": "b1",
      "text": {"type": "plain_text", "text": "Cancel"},
      "value": "<taskId>",
      "style": "danger",
      "action_ts": "1900000000.000201"
    }]
  }
}
```

Hard requirements per handler:
* `cancel_task`: `actions[0].type === "button"`, `actions[0].value`, and `message.ts`.
* `follow_up_task`: `actions[0].type === "button"`, `actions[0].value`, and top-level
  `trigger_id`.
* `view_task_logs`: only `actions[0].action_id`.
Bolt requires `body.actions` to exist to classify the payload as an Action
(`helpers.js:72-78`) and reads `actions[0]` as `payload`.

**View submission (`interactive`)**

```jsonc
"payload": {
  "type": "view_submission",
  "team": {"id": "T_MOCK", "domain": "mock"},
  "user": {"id": "U_HUMAN", "username": "human", "team_id": "T_MOCK"},
  "api_app_id": "A_MOCK",
  "token": "verification-token",
  "trigger_id": "1900000000.000300.abcdef",
  "view": {
    "id": "V_MOCK001",
    "type": "modal",
    "callback_id": "follow_up_submit",
    "private_metadata": "<taskId>",
    "title": {"type": "plain_text", "text": "Follow-up"},
    "blocks": [ /* echo of what views.open received */ ],
    "state": {"values": {
      "follow_up_input": {
        "follow_up_text": {"type": "plain_text_input", "value": "please also check the logs"}
      }
    }},
    "hash": "1900000000.abcdef",
    "team_id": "T_MOCK"
  },
  "response_urls": []
}
```

`view.callback_id`, `view.private_metadata`, `view.state.values.follow_up_input.follow_up_text.value`,
and `user.id` are all mandatory. Bolt classifies on `body.type === "view_submission"`
and matches on `body.view.callback_id`.

### 9.3 Web API methods the mock must implement for the inbound flows

Consumed as a direct result of an inbound event:

* `auth.test` (must return `user_id`, `bot_id`, `team_id`, `user`, `team`, `url`)
* `users.info` (needs `user.profile.email`, `user.profile.real_name`, `user.real_name`)
* `conversations.replies` (three call shapes: `limit:1, inclusive:true`; `limit:20`;
  `oldest:<ts>, include_all_metadata:true, limit:4`)
* `reactions.add` (must be able to return `{ok:false, error:"already_reacted"}`)
* `reactions.remove` (must be able to return `{ok:false, error:"no_reaction"}` and
  `"message_not_found"`)
* `chat.postMessage` (must return `ts`; must honour `thread_ts`, `blocks`, `username`,
  `icon_emoji`, `unfurl_links`, `unfurl_media`, `metadata`)
* `chat.update` (must be able to return `{ok:false, error:"message_not_found"}` so the
  `not_found` recovery paths at `watcher.ts:373-393` and `responses.ts` can be tested)
* `views.open` (must return `{ok:true, view:{id, hash, …}}`)
* `assistant.threads.setStatus`, `assistant.threads.setTitle`,
  `assistant.threads.setSuggestedPrompts`
* `files.info` and the raw `url_private_download` byte endpoint (agent-tool driven)
* `conversations.info`, `conversations.join` (only via `withAutoJoin`,
  `/Users/taras/Documents/code/agent-swarm/src/slack/channel-join.ts:65-95`)
* `POST <response_url>` for `respond()`

Slack error shape the code inspects: `@slack/web-api` throws an `Error` with
`error.data.error` set to the string code, and `error.data.needed` for `missing_scope`
(`ack.ts:8-13`, `channel-join.ts:10-30`). The mock must return non-2xx or `{ok:false,
error:"<code>"}` in the documented way so the SDK builds that shape.

### 9.4 Timing the mock must honour

* No 3-second ack retry exists in Socket Mode Bolt
  (`SocketModeResponseAck.js:13`). The mock should NOT resend on ack latency. To exercise
  retry handling it must deliberately resend the SAME envelope payload with the SAME
  `event_id` (and optionally a bumped `retry_attempt`).
* `event_id` dedup window: 5 minutes (`event-dedup.ts:24`). A resend after 5 minutes will be
  processed again.
* `channel:ts` dedup window: 60 seconds (`handlers.ts:380`).
* ADDITIVE buffer debounce: `ADDITIVE_SLACK_BUFFER_MS`, default 10000 ms, reset on every
  append. Tests should set it to 300-1000 ms.
* Watcher poll: 3000 ms default (`watcher.ts:507`), with a 1000 ms per-task and per-tree
  throttle (`watcher.ts:43, 304`). Expect the first `chat.update` on a tree message roughly
  3 seconds after task creation.
* Rate limit: 10 accepted messages per Slack user per 60 seconds
  (`handlers.ts:395-396`). A test that fires more than 10 messages from one user in a minute
  will see the eleventh silently dropped (or answered with the "sending too many requests"
  message when `SLACK_RENDER_V2` is off).
* `users.info` enrichment cache: 24 h in kv, success only (`enrich.ts:36`).
* `wasThreadStartedBySwarm` cache: permanent per `channel:threadTs`, bounded at 1000 entries
  (`handlers.ts:196-197, 255-260`). The mock cannot change a thread's root author mid-test
  and expect the swarm to notice.

### 9.5 Ordering constraints

* Emit `app_mention` and `message` as two envelopes with distinct `event_id`s for a channel
  mention.
* For the assistant flow emit `assistant_thread_started` before the first
  `message` in that thread, otherwise `saveThreadContext` has nothing to update and
  `setStatus` may legitimately fail (the handler swallows it).
* For `follow_up_task`, the mock must serve `views.open` before it can send the matching
  `view_submission`, because the handler passes `private_metadata` through the view.
* For `cancel_task`, the target task must exist and be non-terminal, and the mock's
  `message.ts` must be a message the mock will accept a `chat.update` for.

---

## 10. Gaps and cautions found while reading

1. `handlers.ts:504-509` claims file_share DM messages bypass the Assistant. In Bolt 4.6.0
   they do not (`Assistant.js:107`). The `assistant_thread` branch is effectively
   test-only unless Slack starts stamping `assistant_thread` on non-thread DM messages.
2. `view_task_logs` and `follow_up_task` handlers are registered but no current Block Kit
   builder emits those `action_id`s. Only `cancel_task` is emitted
   (`blocks.ts:121-136`).
3. `app.event("app_mention")` is a pure logger. Any test that asserts task creation must
   drive the `message` event.
4. `subtype: "channel_join"` messages are not filtered and can enter the ADDITIVE buffer.
5. Event dedup is process-local and unpersisted. Restarting agent-swarm between mock
   deliveries re-enables duplicate processing for the same `event_id`.
6. `SLACK_ALLOWED_USER_IDS` / `SLACK_ALLOWED_EMAIL_DOMAINS` are captured at module load, so a
   test harness cannot flip them between cases in the same process without re-importing
   `handlers.ts`.
7. `context.botUserId` is never used by agent-swarm; three separate `auth.test` caches exist.
   The mock must keep `auth.test` stable and consistent with the `bot_id` it stamps on
   persona messages, or `isSwarmThreadRoot` breaks.
