# R3 — Library internals: what the mock must do for Bolt to connect and work

All evidence is `absolute-path:line` inside
`/Users/taras/Documents/code/agent-swarm/node_modules/@slack/`.
Package versions verified from each `package.json`:

| Package | Version | Evidence |
| --- | --- | --- |
| `@slack/bolt` | 4.6.0 | `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/bolt/package.json:3` |
| `@slack/socket-mode` | 2.0.5 | `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/socket-mode/package.json` |
| `@slack/web-api` | 7.13.0 | `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/web-api/package.json` |
| `@slack/types` | 2.19.0 | `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/types/package.json:3` |
| `@slack/logger` | 4.0.0 | `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/logger/package.json:3` |
| `ws` (hoisted, used by socket-mode) | 8.18.3 | `/Users/taras/Documents/code/agent-swarm/node_modules/ws/package.json` |
| `axios` (nested under web-api and bolt) | 1.12.2 | `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/web-api/node_modules/axios/package.json` |
| `p-retry` | 4.6.2 | `/Users/taras/Documents/code/agent-swarm/node_modules/p-retry/package.json` |

agent-swarm constructs the App with no `clientOptions`:
`/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:44-49`.

---

## A. PLUGGABILITY — can we redirect Bolt at a local mock?

### A.1 The option flows all the way through. Yes.

Chain, verified link by link:

1. `App` destructures `clientOptions` and stores it:
   `bolt/dist/App.js:116` — `this.clientOptions = clientOptions !== undefined ? clientOptions : {};`
2. `App` builds its own bot `WebClient` from it:
   `bolt/dist/App.js:133` — `this.client = new web_api_1.WebClient(token, this.clientOptions);`
3. `App` copies the SAME OBJECT REFERENCE into `installerOptions`:
   `bolt/dist/App.js:146-150`
   ```js
   // Add clientOptions to InstallerOptions to pass them to @slack/oauth
   this.installerOptions = {
       clientOptions: this.clientOptions,
       ...installerOptions,
   };
   ```
   Note the spread order: an explicit `installerOptions.clientOptions` would win.
   agent-swarm passes no `installerOptions`, so `this.clientOptions` survives.
4. `App.initReceiver` passes `installerOptions` to `SocketModeReceiver`:
   `bolt/dist/App.js:725-737` (`installerOptions: this.installerOptions` at line 735).
5. `SocketModeReceiver` forwards **`installerOptions.clientOptions`** (not a top-level
   `clientOptions`) into `SocketModeClient`:
   `bolt/dist/receivers/SocketModeReceiver.js:27-32`
   ```js
   this.client = new socket_mode_1.SocketModeClient({
       appToken,
       logLevel,
       logger,
       clientOptions: installerOptions.clientOptions,
   });
   ```
6. `SocketModeClient` spreads `clientOptions` into its internal `WebClient`, the one that
   calls `apps.connections.open`:
   `socket-mode/dist/src/SocketModeClient.js:107`
   ```js
   this.webClient = new web_api_1.WebClient('', Object.assign({
       logger,
       logLevel: this.logger.getLevel(),
       headers: { Authorization: `Bearer ${appToken}` },
   }, clientOptions));
   ```
7. `WebClient` uses `slackApiUrl` as the axios `baseURL`:
   `web-api/dist/WebClient.js:137` (default `'https://slack.com/api/'`), `:140`, `:167`.

**Conclusion**: one App-level option redirects BOTH the bot Web API client and the
socket-mode `apps.connections.open` call.

### A.2 Exact shape agent-swarm must add

```ts
new App({
  token: botToken,
  appToken,
  socketMode: true,
  logLevel,
  clientOptions: { slackApiUrl: "http://127.0.0.1:PORT/api/" },
});
```

`clientOptions` is `WebClientOptions` — `web-api/dist/WebClient.d.ts:18` declares
`slackApiUrl?: string`.

### A.3 Trailing slash is NOT required

`web-api/dist/WebClient.js:140-143`:
```js
this.slackApiUrl = slackApiUrl;
if (!this.slackApiUrl.endsWith('/')) {
    this.slackApiUrl += '/';
}
```
The client appends one if missing. Supplying it is still clearer.

URL construction for a method call: `web-api/dist/WebClient.js:550-556`
```js
deriveRequestUrl(url) {
    const isAbsoluteURL = url.startsWith('https://') || url.startsWith('http://');
    if (isAbsoluteURL && this.allowAbsoluteUrls) { return url; }
    return `${this.axios.getUri() + url}`;
}
```
So the final URL is `slackApiUrl + methodName`, e.g.
`http://127.0.0.1:PORT/api/chat.postMessage`. `http://` works: there is no scheme check.

### A.4 There is NO environment variable

Grep across `bolt/dist`, `socket-mode/dist/src`, `web-api/dist`, `logger/dist` for
`process.env` returns exactly one hit, and it is inside a JSDoc example:
`web-api/dist/chat-stream.js:19` — `* const client = new WebClient(process.env.SLACK_BOT_TOKEN);`.
No `SLACK_API_URL`, no `SLACK_BASE_URL`. Redirection requires a code change or a
network-level trick.

### A.5 Other redirect routes without touching the App constructor

* **HTTP agent / proxy**: `App` accepts `agent`, and copies it to `clientOptions.agent`
  (`bolt/dist/App.js:117-119`). `WebClient` puts it on `httpAgent`/`httpsAgent`
  (`web-api/dist/WebClient.js:169-170`). `SocketModeClient` reuses
  `this.webClientOptions.agent` as the WebSocket `httpAgent`
  (`socket-mode/dist/src/SocketModeClient.js:145`, used at
  `socket-mode/dist/src/SlackWebSocket.js:72-76`). This still needs a code change (passing
  `agent`), and axios has proxy env support explicitly disabled
  (`web-api/dist/WebClient.js:177` — `proxy: false`).
* **DNS / hosts override for `slack.com`**: would additionally require a trusted TLS cert
  because the default URL is `https://`. Much more work than `slackApiUrl`.
* **`requestInterceptor` / `adapter`**: `web-api/dist/WebClient.js:137,164-165,183-185`.
  Both are `clientOptions` keys, so they need the same code change.

**Recommendation**: add `clientOptions: { slackApiUrl }` in agent-swarm, gated by an env
var, and return `ws://127.0.0.1:PORT/...` from `apps.connections.open`. No TLS anywhere.

### A.6 Two side effects worth knowing

* `App` MUTATES the object you pass as `clientOptions`. It sets `logger`
  (`bolt/dist/App.js:129`) or `logLevel` (`:125`), and `agent`/`tls` when given
  (`:117-122`).
* `SocketModeClient` ALSO mutates it: if `retryConfig` is undefined it writes
  `{ retries: 100, factor: 1.3 }` into the shared object
  (`socket-mode/dist/src/SocketModeClient.js:103-106`). Because the object is shared with
  `App.clientOptions`, every per-team pooled `WebClient` created later inherits that
  policy — see D/H below. `App`'s own `this.client` was already constructed at
  `bolt/dist/App.js:133`, before the receiver at `:171`, so it keeps the default policy.

---

## B. SOCKET MODE HANDSHAKE

### B.1 `apps.connections.open`

* Called from `socket-mode/dist/src/SocketModeClient.js:223` —
  `const resp = yield this.webClient.apps.connections.open({});`
* Bound as a normal Web API method:
  `web-api/dist/methods.js:625` — `open: bindApiCallWithOptionalArgument(this, 'apps.connections.open')`,
  and `bindApiCallWithOptionalArgument` is just `self.apiCall.bind(self, method)`
  (`web-api/dist/methods.js:30-33`).
* Therefore it is an ordinary `apiCall`, so:
  * **HTTP method**: POST. `web-api/dist/WebClient.js:498` — `this.axios.post(url, body, config)`.
    There is no other verb anywhere in `makeRequest`.
  * **URL**: `slackApiUrl + 'apps.connections.open'`
    (`web-api/dist/WebClient.js:210,550-556`).
  * **Body**: `{ team_id: this.teamId, ...options }` (`:211`) with `teamId` undefined, so
    after serialisation the body is the EMPTY STRING (undefined values are dropped at
    `web-api/dist/WebClient.js:571-573`, then `querystring.stringify({})`
    at `:629-634`).
  * **Content-Type**: `application/x-www-form-urlencoded`
    (`web-api/dist/WebClient.js:625-626`).
  * **Authorization**: `Bearer <appToken>`. The socket-mode `WebClient` is constructed
    with token `''` and an explicit header
    (`socket-mode/dist/src/SocketModeClient.js:107`); `WebClient` only auto-sets the
    header when `this.token` is truthy and no header exists
    (`web-api/dist/WebClient.js:162-163`), so the app token wins.
    **This is the xapp- token, not the xoxb- bot token.**
  * **User-Agent**: `web-api/dist/WebClient.js:168` uses `getUserAgent()`
    (`web-api/dist/instrument.js:68-74`). socket-mode registers itself into that string
    at `socket-mode/dist/src/SocketModeClient.js:376`
    (`addAppMetadata({name: '@slack:socket-mode', version: '2.0.5'})`).

### B.2 Fields the client reads from the response

Only two:

1. `ok` — implicitly. `apiCall` throws `platformErrorFromResult(result)` when
   `!result.ok` (`web-api/dist/WebClient.js:241-246`), producing an error with
   `code = 'slack_webapi_platform_error'` and `data = result`
   (`web-api/dist/errors.js:66-70`).
2. `url` — `socket-mode/dist/src/SocketModeClient.js:224-231`:
   ```js
   if (!resp.url) { ... throw new Error(msg); }
   this.numOfConsecutiveReconnectionFailures = 0;
   this.emit(State.Authenticated, resp);
   return resp.url;
   ```

The declared response type only has `ok`, `url`, `error`, `needed`, `provided`
(`web-api/dist/types/response/AppsConnectionsOpenResponse.d.ts:2-8`).

Minimal valid response body: `{"ok":true,"url":"ws://127.0.0.1:PORT/link/<ticket>"}`.

### B.3 WebSocket connect

`socket-mode/dist/src/SlackWebSocket.js:70-76`:
```js
const options = { perMessageDeflate: false, agent: this.options.httpAgent };
this.websocket = new ws_1.WebSocket(this.options.url, options);
```

* **No subprotocol** is requested (second positional arg is the options object, not a
  protocols array).
* **No Authorization header** on the upgrade. The URL from `apps.connections.open` is the
  ONLY credential. The mock must therefore embed a ticket / connection id in that URL if
  it wants to correlate the socket with an app.
* `perMessageDeflate: false` — the mock must not require compression.
* Headers are whatever `ws` 8.18.3 sends: `Upgrade`, `Connection`, `Sec-WebSocket-Key`,
  `Sec-WebSocket-Version: 13`, `Host`.
* On `open` the client immediately starts its ping timer:
  `socket-mode/dist/src/SlackWebSocket.js:77-80`.

### B.4 What the client expects first, and when `app.start()` resolves

`socket-mode/dist/src/SocketModeClient.js:283-286`:
```js
if (event.type === 'hello') {
    this.emit(State.Connected);
    return;
}
```

**The ONLY field read is `type === 'hello'`.** `num_connections`,
`connection_info.app_id`, `debug_info` are never parsed. They are cosmetic; send them for
realism if you like.

`start()` resolves when `State.Connected` fires:
`socket-mode/dist/src/SocketModeClient.js:151-169` registers `once(State.Connected, ...)`
at `:165` and `once(State.Disconnected, ...)` at `:166`, then connects at `:168`.

Full resolution chain for `await app.start()`:
`bolt/dist/App.js:298` (`this.receiver.start()`)
-> `bolt/dist/receivers/SocketModeReceiver.js:167` (`this.client.start()`)
-> `socket-mode/dist/src/SocketModeClient.js:132-171`.

So: `apps.connections.open` -> WS upgrade -> mock sends `{"type":"hello"}` -> `app.start()`
resolves. If the mock never sends `hello`, `app.start()` hangs forever (there is no
handshake timeout in the client). That is the single most likely mock bug.

`start()` resolves with `AppsConnectionsOpenResponse` per
`socket-mode/dist/src/SocketModeClient.d.ts:66`. Note the resolve value is actually the
`State.Connected` emit payload, which is empty — a cosmetic type mismatch, harmless.

---

## C. ENVELOPES AND ACKS

### C.1 The envelope parser

`socket-mode/dist/src/SocketModeClient.js:262-333` is the whole contract.

* Binary frames are ignored: `:265-268`.
* Non-JSON text frames are logged and ignored, no crash: `:274-281`.
* `type: 'hello'` -> `State.Connected`, return (`:283-286`).
* `type: 'disconnect'` -> log `event.reason`, call `websocket.disconnect()`, return
  (`:288-292`).
* Everything else is treated as an envelope.

Fields read off the envelope:

| Field | Read at | Notes |
| --- | --- | --- |
| `type` | `:283`, `:288`, `:301`, `:314`, `:326` | routing discriminator |
| `envelope_id` | `:296`, `:298`, `:303`, `:316`, `:325` | required for ack |
| `payload` | `:302`, `:304`, `:305`, `:317`, `:328` | the actual Slack body |
| `payload.event.type` | `:302` | only for `events_api` |
| `retry_attempt` | `:307`, `:329` | mapped to `retry_num` |
| `retry_reason` | `:308`, `:330` | passed through |
| `accepts_response_payload` | `:309`, `:318`, `:330` | passed through, never acted on |

### C.2 Type mapping to emitted events

`socket-mode/dist/src/SocketModeClient.js:300-331`:

* `events_api` -> emits under the **inner event type** (e.g. `'message'`,
  `'app_mention'`), with `{ack, envelope_id, body: payload, event: payload.event,
  retry_num, retry_reason, accepts_response_payload}` (`:301-311`).
* anything else (`interactive`, `slash_commands`, ...) -> emits under the ENVELOPE type
  with `{ack, envelope_id, body: payload, accepts_response_payload}` (`:312-320`).
  Note: no `retry_num`/`retry_reason` on this branch.
* **In every non-hello, non-disconnect case it also emits `'slack_event'`** (`:323-331`).

Bolt subscribes ONLY to `'slack_event'`:
`bolt/dist/receivers/SocketModeReceiver.js:133-156`. It builds a `ReceiverEvent`
(`bolt/dist/types/receiver.d.ts:4-10`) of `{body, ack, retryNum, retryReason,
customProperties}` and calls `app.processEvent(event)` at `:144`.

Bolt then classifies **by the shape of `payload`, not by the envelope type**:
`bolt/dist/helpers.js:26-97` (`getTypeAndConversation`):

| Condition | Classified as | Line |
| --- | --- | --- |
| `body.event !== undefined` | `Event` | `:27-57` |
| `body.command !== undefined` | `Command` | `:58-63` |
| `body.name !== undefined \|\| body.type === 'block_suggestion'` | `Options` | `:64-70` |
| `body.actions !== undefined \|\| type 'dialog_submission' \|\| 'workflow_step_edit'` | `Action` | `:72-78` |
| `body.type === 'shortcut'` | `Shortcut` | `:79-83` |
| `body.type === 'message_action'` | `Shortcut` | `:84-90` |
| `body.type === 'view_submission' \|\| 'view_closed'` | `ViewAction` | `:91-95` |
| otherwise | `{}` -> warn and drop | `:96`, consumed at `bolt/dist/App.js:435-438` |

**Practical consequence for the mock**: the envelope `type` string only has to be
something other than `hello`/`disconnect`. What actually decides Bolt's behaviour is the
payload keys. Still, use the real strings (`events_api`, `interactive`,
`slash_commands`) so the socket-mode `emit(event.type, ...)` fan-out is realistic.

### C.3 Ack on the wire

`socket-mode/dist/src/SocketModeClient.js:340-368`:
```js
send(id, body = {}) {
    const _body = typeof body === 'string' ? { text: body } : body;
    const message = { envelope_id: id, payload: Object.assign({}, _body) };
    ...
    const flatMessage = JSON.stringify(message);
    this.websocket.send(flatMessage, (error) => {...});
}
```

So the ack frame is exactly:
```json
{"envelope_id":"<id>","payload":{ ... }}
```
`payload` is ALWAYS present. `ack()` with no argument yields `"payload":{}`.
`ack("some text")` yields `"payload":{"text":"some text"}`.
`ack({response_type:'ephemeral', text:'hi'})` yields that object verbatim.

The ack is refused (promise rejects) if the socket is missing or not `OPEN`:
`socket-mode/dist/src/SocketModeClient.js:347-354`, using `isActive()`
(`socket-mode/dist/src/SlackWebSocket.js:151-159`, `readyState === 1`).

### C.4 WHEN Bolt acks

This is the important asymmetry, at `bolt/dist/App.js:639-653`:

```js
// Set ack() utility
if (type !== helpers_1.IncomingEventType.Event) {
    listenerArgs.ack = ack;
}
else {
    const eventListenerArgs = listenerArgs;
    if (eventListenerArgs.event?.type === 'function_executed') {
        listenerArgs.ack = ack;
    }
    else {
        // Events API requests are acknowledged right away, since there's no data expected
        await ack();
    }
}
```

* **`events_api` (except `function_executed`)**: Bolt acks IMMEDIATELY, BEFORE any global
  middleware or listener runs (middleware dispatch starts at `bolt/dist/App.js:656`).
  Listeners get no `ack` argument at all. The ack payload is `{}`.
* **`slash_commands`, `interactive`, `view_submission`, `shortcut`, options**: `ack` is
  handed to the listener. Nothing is sent until user code calls `ack(...)`. The value
  passed to `ack` becomes the envelope `payload`, which is what Slack renders as the
  synchronous response body (e.g. `{response_type, text, blocks}` for a slash command,
  or a `response_action` for a view submission).

Double-ack is a warning, not an error:
`bolt/dist/receivers/SocketModeResponseAck.js:15-26` — the second call logs
`'ack() has already been called. Additional calls will be ignored...'` and returns.

### C.5 If a listener never acks

**Nothing happens on the Bolt side.** There is no timer.
`bolt/dist/receivers/SocketModeResponseAck.js:13` says so explicitly:
```js
// TODO: a Timeout should be used to acknowledge the request after 3 seconds and mimic the HTTPReceiver behavior
```
Compare with `bolt/dist/receivers/HTTPResponseAck.js`, which does have the 3-second
timer. For Socket Mode there is no `AckTimeoutError` and no warning.

If `processEvent` THROWS, `SocketModeReceiver` runs
`processEventErrorHandler` (`bolt/dist/receivers/SocketModeReceiver.js:147-155`); the
default returns `true` only for `ErrorCode.AuthorizationError`
(`bolt/dist/receivers/SocketModeFunctions.js:12-17`), in which case Bolt acks to stop
Slack's retries.

**Mock requirement**: the mock is the party that must implement ack timeouts / retries if
tests want to exercise them. Suggest: track pending `envelope_id`s, expose them for
assertions, and optionally re-deliver with `retry_attempt` incremented.

---

## D. PING / PONG AND LIVENESS

### D.1 Defaults

`socket-mode/dist/src/SocketModeClient.js:73`:
```js
constructor({ logger, logLevel, autoReconnectEnabled = true, pingPongLoggingEnabled = false,
             clientPingTimeout = 5000, serverPingTimeout = 30000, appToken = '', clientOptions = {} })
```
`bolt/dist/receivers/SocketModeReceiver.js:27-32` passes NONE of these, so agent-swarm
gets: `autoReconnectEnabled=true`, `clientPingTimeout=5000`, `serverPingTimeout=30000`,
`pingPongLoggingEnabled=false`. They are not reachable from `App` options at all.

Semantics are documented at `socket-mode/dist/src/SocketModeOptions.d.ts:22-40`.

`SlackWebSocket` receives them at
`socket-mode/dist/src/SocketModeClient.js:146-148` and defaults them again at
`socket-mode/dist/src/SlackWebSocket.js:47`.

Note: `pingInterval = 5000` in that same signature is DEAD CONFIG. The interval actually
used is `clientPingTimeoutMS / 3` (`socket-mode/dist/src/SlackWebSocket.js:229`).

### D.2 Client -> server: protocol-level ping frames, ~every 1667 ms

`socket-mode/dist/src/SlackWebSocket.js:191-231` (`monitorPingToSlack`), started from the
`open` handler at `:77-80`:

```js
this.clientPingTimeout = setInterval(() => {
    const now = Date.now();
    const pingMessage = `Ping from client (${now})`;
    this.websocket?.ping(pingMessage);          // :200  -> WS PING frame, opcode 0x9
    if (this.lastPongReceivedTimestamp === undefined) { pingAttemptCount += 1; }
    else { pingAttemptCount = 0; }
    ...
    let isInvalid = pingAttemptCount > 3;        // :218
    if (this.lastPongReceivedTimestamp !== undefined) {
        const millis = now - this.lastPongReceivedTimestamp;
        isInvalid = millis > this.options.clientPingTimeoutMS;   // :223
    }
    if (isInvalid) { this.logger.warn(...); this.disconnect(); } // :225-228
}, this.options.clientPingTimeoutMS / 3);        // :229 -> 1666.67 ms
```

These are **WebSocket protocol PING frames** (`ws`'s `.ping()`), not JSON messages.

Two failure conditions:
* **Cold start**: if no pong ever arrives, `pingAttemptCount` reaches 4 on the 4th tick,
  i.e. at about **6.67 s** after `open`, and the client disconnects.
* **Steady state**: once at least one pong has arrived, a disconnect happens on the first
  tick where `now - lastPongReceivedTimestamp > 5000`. With a 1667 ms tick, the mock must
  answer a pong at least every ~5 s.

Pongs are recorded at `socket-mode/dist/src/SlackWebSocket.js:103-108`
(`this.lastPongReceivedTimestamp = Date.now()`).

**Mock requirement**: the WS server MUST reply to PING frames with PONG frames. Node's
`ws` does this automatically (`autoPong` default true since ws 8.16; the client relies on
the same behaviour for the reverse direction, see the comment at
`socket-mode/dist/src/SlackWebSocket.js:96-97`). If the mock uses `Bun.serve`, verify Bun
auto-pongs; otherwise send an explicit pong.

### D.3 Server -> client: pings are OPTIONAL

`socket-mode/dist/src/SlackWebSocket.js:95-102`:
```js
this.websocket.on('ping', (data) => {
    // Note that ws' `autoPong` option is true by default, so no need to respond to ping.
    if (this.options.pingPongLoggingEnabled) { this.logger.debug(...); }
    this.monitorPingFromSlack();
});
```
And `monitorPingFromSlack` at `:180-186`:
```js
monitorPingFromSlack() {
    clearTimeout(this.serverPingTimeout);
    this.serverPingTimeout = setTimeout(() => {
        this.logger.warn(`A ping wasn't received from the server before the timeout of ${...}ms!`);
        this.disconnect();
    }, this.options.serverPingTimeoutMS);
}
```

**Critical detail**: `monitorPingFromSlack()` is called ONLY from the `ping` handler.
The 30 s server-ping timer is never armed until the server sends its FIRST ping. So a
mock that NEVER pings is fine and will never trip the 30 s timeout. But a mock that pings
ONCE and then stops will be disconnected 30 s later.

**Mock rule**: either never send server pings at all, or send them on a fixed interval
strictly under 30 s (10 s is a safe choice) for the lifetime of the socket.

### D.4 pingPongLoggingEnabled

`socket-mode/dist/src/SocketModeClient.js:88`, used at
`socket-mode/dist/src/SlackWebSocket.js:98-100`, `:104-106`, `:208-210`. Pure DEBUG
logging. Not settable from Bolt. Default `false`.

---

## E. DISCONNECT AND RECONNECT

### E.1 `{type:'disconnect'}` handling

`socket-mode/dist/src/SocketModeClient.js:288-292`:
```js
if (event.type === 'disconnect') {
    this.logger.debug(`Received "${event.type}" (${event.reason}) message - disconnecting.${this.autoReconnectEnabled ? ' Will reconnect.' : ''}`);
    this.websocket?.disconnect();
    return;
}
```

**`reason` is logged and otherwise ignored.** A grep across `socket-mode/dist/src` for
`refresh_requested`, `link_disabled`, `too_many_websockets`, `warning` finds nothing. All
reasons behave identically in 2.0.5.

### E.2 Close sequence

`socket-mode/dist/src/SlackWebSocket.js:113-132` (`disconnect`):
* If a close frame was already received -> `terminate()` right away (`:117-120`).
* Otherwise send a close frame with status **1000** and wait for the peer's reply
  (`:124-125` — `this.websocket.close(1000)`).

`close` handler at `:89-93` sets `closeFrameReceived = true` and re-enters `disconnect()`,
which now terminates.

`terminate()` at `:136-146`: removes all listeners, calls `ws.terminate()`, nulls the
socket, clears BOTH timers (`clearTimeout(serverPingTimeout)`,
`clearInterval(clientPingTimeout)`), then `client.emit('close')`.

### E.3 Reconnect policy

`socket-mode/dist/src/SocketModeClient.js:113-122`:
```js
this.on('close', () => {
    if (!this.shuttingDown && this.autoReconnectEnabled) { this.delayReconnectAttempt(this.start); }
    else { this.emit(State.Disconnected); }
});
```

Backoff at `socket-mode/dist/src/SocketModeClient.js:198-214`:
```js
delayReconnectAttempt(cb) {
    this.numOfConsecutiveReconnectionFailures += 1;
    const msBeforeRetry = this.clientPingTimeoutMS * this.numOfConsecutiveReconnectionFailures;
    ...
    setTimeout(() => { ... this.emit(State.Reconnecting); cb.apply(this).then(res); }, msBeforeRetry);
}
```

**Linear backoff of `5000 ms * attempt#`**: 5 s, 10 s, 15 s, ... The counter resets to 0
only on a successful `apps.connections.open` (`:229`). It is NOT reset by a successful
`hello`, so a mock that accepts the HTTP call but then closes the socket produces a
5 s, 5 s, 5 s ... loop (the counter is zeroed each time `retrieveWSSURL` succeeds).

Failures of `apps.connections.open` itself also retry through the same helper
(`:248-250`), except for unrecoverable cases at `:236-247`:
* `PlatformError` whose `data.error` is one of `not_authed`, `invalid_auth`,
  `account_inactive`, `user_removed_from_team`, `team_disabled`
  (`socket-mode/dist/src/UnrecoverableSocketModeStartError.js:8-12`)
* `RequestError` (connection refused / DNS)
* `HTTPError` (non-200, non-429 status)

Those three rethrow, so `app.start()` rejects. **This is how the mock makes a test fail
fast**: return HTTP 200 with `{"ok":false,"error":"invalid_auth"}`.

### E.4 `app.stop()`

`bolt/dist/App.js:301-303` -> `bolt/dist/receivers/SocketModeReceiver.js:169-186` ->
`this.client.disconnect()` at `:179`.
`socket-mode/dist/src/SocketModeClient.js:176-192`: sets `shuttingDown = true` (so the
`close` handler will NOT reconnect), emits `Disconnecting`, then calls
`websocket.disconnect()`, i.e. **close code 1000**.

Caveat: `SocketModeReceiver.stop()` resolves its promise immediately at
`bolt/dist/receivers/SocketModeReceiver.js:180` WITHOUT awaiting the inner disconnect
promise. So `await app.stop()` can return before the socket is fully closed. Tests that
assert "socket closed" must poll the mock, not trust `await app.stop()`.

---

## F. AUTH

### F.1 When `auth.test` is called

agent-swarm passes `token` and no `authorize`, and leaves `tokenVerificationEnabled`
at its default `true` (`bolt/dist/App.js:81`), and `deferInitialization` at `false`.

Path: `bolt/dist/App.js:174-192` builds
`argAuthorization = {botId: undefined, botUserId: undefined, botToken: token}` at
`:175-181`, then calls `initAuthorizeInConstructor` at `:190`, which reaches
`singleAuthorization(this.client, authorization, true)` at `:801`.

`bolt/dist/App.js:830-844`:
```js
function singleAuthorization(client, authorization, tokenVerificationEnabled) {
    let cachedAuthTestResult;
    if (tokenVerificationEnabled) {
        // call auth.test immediately
        cachedAuthTestResult = runAuthTestForBotToken(client, authorization);
        return async ({ isEnterpriseInstall }) => buildAuthorizeResult(isEnterpriseInstall, cachedAuthTestResult, authorization);
    }
    return async ({ isEnterpriseInstall }) => { /* lazy, per-call */ };
}
```

and `bolt/dist/App.js:818-825`:
```js
function runAuthTestForBotToken(client, authorization) {
    return authorization.botUserId !== undefined && authorization.botId !== undefined
        ? Promise.resolve({ botUserId: authorization.botUserId, botId: authorization.botId })
        : client.auth.test({ token: authorization.botToken }).then((result) => ({
            botUserId: result.user_id,
            botId: result.bot_id,
        }));
}
```

**Timing**: the promise is created SYNCHRONOUSLY inside `new App(...)`, and is NOT
awaited there. So `auth.test` hits the mock as soon as `new App()` runs, which is BEFORE
`app.start()`. The mock's HTTP server must already be listening at construction time.

**Caching**: the promise is stored in the closure variable `cachedAuthTestResult` and
reused for every event (`:837`). So `auth.test` is called exactly ONCE per App instance.

If `botId` AND `botUserId` were both supplied as App options, `auth.test` would be skipped
entirely (`:820-821`). agent-swarm supplies neither
(`/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:44-49`).

### F.2 Fields Bolt reads from `auth.test`

Only two: `user_id` and `bot_id` (`bolt/dist/App.js:823-824`). The full declared response
type is `web-api/dist/types/response/AuthTestResponse.d.ts:2-18` (`app_id`, `app_name`,
`bot_id`, `enterprise_id`, `error`, `expires_in`, `is_enterprise_install`, `needed`, `ok`,
`provided`, `team`, `team_id`, `url`, `user`, `user_id`). The mock should return them all
for realism, but Bolt needs `ok`, `user_id`, `bot_id`.

Note: `App.init()` (deferred path only) reads a slightly different set —
`authTestResult.user_id` and `authTestResult.bot_id` at `bolt/dist/App.js:221-222`.
Same two fields.

### F.3 How context gets populated

`bolt/dist/App.js:827-828`:
```js
async function buildAuthorizeResult(isEnterpriseInstall, authTestResult, authorization) {
    return { isEnterpriseInstall, botToken: authorization.botToken, ...(await authTestResult) };
}
```
So the authorize result is `{isEnterpriseInstall, botToken, botUserId, botId}`.

`bolt/dist/App.js:471-495` then fills in `userId`, `teamId`, `enterpriseId` from the event
body (via `buildSource`, `bolt/dist/App.js:850+`) when the authorize result did not supply
them, and spreads everything into `context` at `:489-495`.

`context.botUserId` and `context.botId` are what `ignoreSelf`
(`bolt/dist/middleware/builtin.js:257-279`) and `directMention`
(`bolt/dist/middleware/builtin.js:298-313`) use, and what
`DefaultThreadContextStore` matches on
(`bolt/dist/AssistantThreadContextStore.js:26`, `:46`).

**`ignoreSelf` consequence for the mock**: `bolt/dist/App.js:194-196` registers it by
default (`ignoreSelf` App option defaults to `true` at `bolt/dist/App.js:81`). Any
`message` event the mock delivers with `subtype === 'bot_message' && bot_id === <botId
from auth.test>` is dropped (`builtin.js:263-265`), and any event with
`user === <user_id from auth.test>` is dropped unless it is `member_joined_channel` or
`member_left_channel` (`builtin.js:269-275`). So the mock must NOT echo the bot's own
posts back as inbound events with the bot's identity, or Bolt will silently swallow them.

### F.4 Other API calls on start

**None.** `bolt/dist/App.js` contains exactly one `auth.test` call site pair
(`:218` for the deferred path, `:822` for the constructor path) and no `bots.info`,
`team.info`, `users.info`, or `apps.*` call. Grep for `bots.info` in `bolt/dist` returns
nothing. `SocketModeReceiver` calls nothing but `apps.connections.open` (indirectly).

So the whole startup surface the mock must serve is:
1. `POST /api/auth.test` (bot token, at `new App()`)
2. `POST /api/apps.connections.open` (app token, at `app.start()`)
3. WS upgrade + `hello`

---

## G. ASSISTANT MIDDLEWARE

agent-swarm registers it: `app.assistant(createAssistant())` at
`/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:62`, which pushes the
assistant's middleware onto the GLOBAL middleware chain
(`bolt/dist/App.js:258-262`).

### G.1 Which payload types it intercepts

`bolt/dist/Assistant.js:11`:
```js
const ASSISTANT_PAYLOAD_TYPES = new Set(['assistant_thread_started', 'assistant_thread_context_changed', 'message']);
```
Gate at `bolt/dist/Assistant.js:33-39`:
```js
getMiddleware() {
    return async (args) => {
        if (isAssistantEvent(args) && matchesConstraints(args)) { return this.processEvent(args); }
        return args.next();
    };
}
```
`isAssistantEvent` checks `ASSISTANT_PAYLOAD_TYPES.has(args.payload.type)`
(`bolt/dist/Assistant.js:87-89`).

### G.2 The exact condition for `userMessage` vs the plain `message` listener

`bolt/dist/Assistant.js:95-109`:
```js
function matchesConstraints(args) {
    return args.payload.type === 'message' ? isAssistantMessage(args.payload) : true;
}
function isAssistantMessage(payload) {
    const isThreadMessage = 'channel' in payload && 'thread_ts' in payload;
    const inAssistantContainer = 'channel_type' in payload &&
        payload.channel_type === 'im' &&
        (!('subtype' in payload) || payload.subtype === 'file_share' || payload.subtype === undefined);
    return isThreadMessage && inAssistantContainer;
}
```

So `userMessage` fires when ALL of:
* `payload.type === 'message'`
* `payload.channel` present
* `payload.thread_ts` present (key present; the value is not checked here)
* `payload.channel_type === 'im'`
* `subtype` absent, `undefined`, or exactly `'file_share'`

Otherwise the plain `app.message(...)` listener path runs.

**Crucial routing side effect**: `enrichAssistantArgs` STRIPS `next` from the args
(`bolt/dist/Assistant.js:70-72` — `const { next: _next, ...assistantArgs } = args;`), and
`processEvent` never calls it. So when the Assistant matches, the global middleware chain
STOPS and no `app.message` / `app.event` listener runs at all. The mock's payloads
therefore decide which of the two agent-swarm code paths is exercised. Getting
`channel_type: 'im'` or `thread_ts` wrong silently switches the code path.

Also note `extractThreadInfo` (`bolt/dist/Assistant.js:265-298`) THROWS
`AssistantMissingPropertyError` if it cannot resolve both `channelId` and `threadTs`
(`:286-296`). For `assistant_thread_started` it reads
`payload.assistant_thread.channel_id` / `.thread_ts` / `.context` (`:270-279`), matching
`@slack/types/dist/events/assistant.d.ts:1-14`.

### G.3 Utilities and their exact API calls

Installed at `bolt/dist/Assistant.js:74-79`.

| Utility | Method called | Argument keys | Evidence |
| --- | --- | --- | --- |
| `say(msg)` | `chat.postMessage` | `text` (or spread message) + `channel`, `thread_ts`, and conditionally `metadata: {event_type, event_payload}` | `bolt/dist/Assistant.js:191-208` (call at `:206`) |
| `setStatus(s)` | `assistant.threads.setStatus` | `channel_id`, `thread_ts`, `status` (string form) or `channel_id`, `thread_ts`, `...status` (object form, allows `loading_messages`) | `bolt/dist/Assistant.js:213-230`; args type `web-api/dist/types/request/assistant.d.ts:2-11` |
| `setTitle(t)` | `assistant.threads.setTitle` | `channel_id`, `thread_ts`, `title` | `bolt/dist/Assistant.js:252-260`; args type `web-api/dist/types/request/assistant.d.ts:28-35` |
| `setSuggestedPrompts({prompts,title})` | `assistant.threads.setSuggestedPrompts` | `channel_id`, `thread_ts`, `prompts` (array of `{title,message}`), `title` | `bolt/dist/Assistant.js:235-247`; args type `web-api/dist/types/request/assistant.d.ts:12-27` |
| `getThreadContext()` | `conversations.replies` | `channel`, `ts`, `oldest`, `include_all_metadata: true`, `limit: 4` | `bolt/dist/AssistantThreadContextStore.js:15-21` |
| `saveThreadContext()` | `conversations.replies` then `chat.update` | replies as above; update with `channel`, `ts`, `text`, `blocks`, `metadata:{event_type:'assistant_thread_context', event_payload}` | `bolt/dist/AssistantThreadContextStore.js:35-58` |

The three `assistant.threads.*` methods are bound at
`web-api/dist/methods.js:605`, `:610`, `:615`.

### G.4 `say()` metadata detail

`bolt/dist/Assistant.js:194-206`:
```js
const threadContext = context.channel_id ? context : await args.getThreadContext();
const postMessageArgument = typeof message === 'string' ? { text: message, channel, thread_ts } : { ...message, channel, thread_ts };
if (threadContext || postMessageArgument.metadata) {
    postMessageArgument.metadata = {
        event_type: postMessageArgument.metadata?.event_type ?? 'assistant_thread_context',
        event_payload: { ...threadContext, ...(postMessageArgument.metadata?.event_payload ?? {}) },
    };
}
return client.chat.postMessage(postMessageArgument);
```
`threadContext` is always at least `{}` (truthy), so `say()` from an assistant handler
ALWAYS attaches a `metadata` object. The mock must accept and (ideally) persist
`metadata` on `chat.postMessage`, and echo it back on `conversations.replies` when
`include_all_metadata=true`.

Note the branch at `:195`: if the incoming payload carried a non-empty
`assistant_thread.context` with a `channel_id`, `say()` uses it directly and does NOT
call `conversations.replies`. If the context is empty (the usual case for a plain message
in an assistant thread), `getThreadContext()` runs, which hits `conversations.replies`.

### G.5 Default context store lookup key

`bolt/dist/AssistantThreadContextStore.js:26` and `:46`:
```js
const initialMsg = thread.messages.find((m) => !('subtype' in m) && m.user === context.botUserId);
```
So `conversations.replies` must return messages where the bot's own root message has
`user === <auth.test user_id>` and NO `subtype` key at all. If the mock adds
`subtype: undefined` as an explicit key, `'subtype' in m` is TRUE and the lookup fails.
`saveThreadContext` then silently does nothing.

Also `bolt/dist/AssistantThreadContextStore.js:10-12`: `get()` short-circuits on an
in-memory `this.context` once it has a `channel_id`, so the second and later calls in the
same process skip the API entirely.

---

## H. WEB CLIENT WIRE FORMAT

### H.1 Request construction

* **URL**: `slackApiUrl + method` (`web-api/dist/WebClient.js:210`, `:550-556`,
  baseURL at `:167`).
* **HTTP method**: always POST (`web-api/dist/WebClient.js:498`).
* **Redirects**: `maxRedirects: 0` (`web-api/dist/WebClient.js:172`). The mock must not
  302.
* **Status handling**: `validateStatus: () => true`
  (`web-api/dist/WebClient.js:171`), so axios never throws on status; the library decides.
* **Headers**:
  * `Authorization: Bearer <token>` — set at construction
    (`web-api/dist/WebClient.js:162-163`) or per-call when `options.token` is present
    (`web-api/dist/WebClient.js:207-209`).
  * `User-Agent` — `web-api/dist/WebClient.js:168`,
    built at `web-api/dist/instrument.js:53-55,68-74`. Shape:
    `@slack:socket-mode/2.0.5 @slack:bolt/4.6.0 @slack:web-api/7.13.0 bun/<ver> darwin/<rel>`
    (registrants: `socket-mode/dist/src/SocketModeClient.js:376` and
    `bolt/dist/App.js:1012`, both calling `addAppMetadata`).
  * `Content-Type` — set per-request by the serializer, never a default
    (`web-api/dist/WebClient.js:180` explicitly clears the axios post default).

### H.2 Body serialisation

`web-api/dist/WebClient.js:564-637` (`serializeApiCallData`, installed as a request
interceptor at `:186`):

1. `undefined`/`null` values are DROPPED (`:571-573`).
2. `Buffer` or stream values set `containsBinaryData = true` (`:575-577`).
3. Anything that is NOT string/number/boolean/Buffer/stream is `JSON.stringify`'d
   (`:578-582`). **This is how `blocks`, `attachments`, `metadata`, `files`,
   `loading_messages`, `prompts` arrive: as JSON-encoded STRING form fields.**
4. If binary present -> `multipart/form-data` via `form-data`, headers merged from
   `form.getHeaders()` (`:586-622`).
5. Otherwise -> `Content-Type: application/x-www-form-urlencoded` and
   `querystring.stringify(...)` (`:625-634`).

**Mock requirement**: parse `application/x-www-form-urlencoded`, then `JSON.parse` the
`blocks` / `attachments` / `metadata` / `files` fields when present. Booleans arrive as
the literal strings `"true"` / `"false"`; numbers as decimal strings.

### H.3 Response parsing and error semantics

`web-api/dist/WebClient.js:643-711` (`buildResult`):
* String bodies are `JSON.parse`d; on failure the result becomes
  `{ok:false, error:<raw string>}` (`:682-691`). A mock returning HTML on error produces a
  confusing `PlatformError` whose `data.error` is the HTML.
* `response_metadata` is created if absent (`:692-694`).
* `x-oauth-scopes` / `x-accepted-oauth-scopes` headers are split into
  `response_metadata.scopes` / `.acceptedScopes` (`:696-703`).
* `retry-after` header -> `response_metadata.retryAfter` (`:705-708`, parser at
  `:740-748`).

Then `apiCall` (`web-api/dist/WebClient.js:241-246`):
```js
if (!result.ok && response.headers['content-type'] !== 'application/gzip') { throw platformErrorFromResult(result); }
if ('ok' in result && result.ok === false) { throw platformErrorFromResult(result); }
```
`platformErrorFromResult` -> `Error('An API error occurred: ' + result.error)` with
`code = 'slack_webapi_platform_error'` and `data = result`
(`web-api/dist/errors.js:66-70`).

**So `ok` is mandatory in every mock response.** Omitting `ok` throws.

Warnings: `response_metadata.warnings[]` is logged via `logger.warn`
(`web-api/dist/WebClient.js:215-217`); `response_metadata.messages[]` entries matching
`[ERROR]...` / `[WARN]...` are logged at the matching level (`:220-237`).

### H.4 HTTP status handling and retries

`web-api/dist/WebClient.js:470-544` (`makeRequest`):
* **429**: read `retry-after` seconds (`:501`, parser `:740-748`). If parsable:
  emit `rate_limited` (`:503`); if `rejectRateLimitedCalls` (default `false`,
  `:137`, `:148`) throw a non-retryable `AbortError` (`:504-506`); otherwise PAUSE the
  request queue, `await delay(retrySec * 1000)`, resume, and throw a retryable error
  (`:507-520`). If `retry-after` is missing or unparsable -> `AbortError`, no retry
  (`:522-523`).
* **Any status other than 200 or 429** -> `httpErrorFromResponse(response)` (`:526-527`),
  code `slack_webapi_http_error` (`web-api/dist/errors.js:48-61`). This IS wrapped by
  `p-retry`, so a 500 is retried per the retry policy.
* **Network errors** -> `requestErrorWithOriginal`, code `slack_webapi_request_error`
  (`:531-539`, `web-api/dist/errors.js:37-43`).
* Retries: `p_retry(task, this.retryConfig)` (`:543`).

**Retry policy defaults, and the socket-mode contamination:**
* Library default is `tenRetriesInAboutThirtyMinutes = {retries: 10, factor: 1.96821,
  randomize: true}` (`web-api/dist/retry-policies.js:9-13`), applied at
  `web-api/dist/WebClient.js:137`.
* But `SocketModeClient` writes `{retries: 100, factor: 1.3}` into the SHARED
  `clientOptions` object when `retryConfig` is undefined
  (`socket-mode/dist/src/SocketModeClient.js:103-106`). Because
  `bolt/dist/App.js:148` shares that same object, and `bolt/dist/App.js:561` copies it
  for per-team pooled clients (`:581`), **the `client` handed to listeners retries up to
  100 times**. `App.this.client` (used by `say()` at `bolt/dist/App.js:519`) is
  constructed at `:133`, BEFORE the receiver at `:171`, so it keeps `retries: 10`.
* Underlying `retry` defaults: `minTimeout: 1000`, `maxTimeout: Infinity`, `factor: 2`
  (`/Users/taras/Documents/code/agent-swarm/node_modules/retry/lib/retry.js:18-21`),
  overridden by the policy above. `p-retry` version 4.6.2.

**Mock rule (non-negotiable)**: signal API errors as **HTTP 200 with
`{"ok":false,"error":"..."}"`**, never as 4xx/5xx. A 500 triggers a multi-minute retry
storm that will hang E2E tests. Only use non-200 deliberately, to test retry behaviour.

`maxRequestConcurrency` default is 100 (`web-api/dist/WebClient.js:137`, queue at `:145`),
so the mock can see up to 100 in-flight requests per client.

### H.5 `filesUploadV2` — exact sequence

`web-api/dist/WebClient.js:369-386`:
```js
filesUploadV2(options) {
    const fileUploads = yield this.getAllFileUploads(options);          // :373
    const fileUploadsURLRes = yield this.fetchAllUploadURLExternal(fileUploads); // :374
    fileUploadsURLRes.forEach((res, idx) => {                            // :376-379
        fileUploads[idx].upload_url = res.upload_url;
        fileUploads[idx].file_id = res.file_id;
    });
    yield this.postFileUploadsToExternalURL(fileUploads, options);      // :381
    const completion = yield this.completeFileUploads(fileUploads);     // :383
    return { ok: true, files: completion };                             // :384
}
```
Dispatched from `apiCall` when the method name is `files.uploadV2`
(`web-api/dist/WebClient.js:205-206`), and also bound as `client.files.uploadV2`
(`web-api/dist/methods.js:34-36`).

**Step 1 — `files.getUploadURLExternal`**, one call per file:
`web-api/dist/WebClient.js:393-408`, args at `:396-405`:
`{filename, length, alt_text, snippet_type}` plus `token` when present.
`length` is `Buffer.byteLength(data, 'utf8')`
(`web-api/dist/file-upload.js:170-175`); the data is always coerced to a Buffer
(`web-api/dist/file-upload.js:140-168`).
Response must supply `upload_url` and `file_id`
(`web-api/dist/types/response/FilesGetUploadURLExternalResponse.d.ts:2-10`).
`upload_url` must be an ABSOLUTE `http://`/`https://` URL, otherwise axios prefixes the
`baseURL`.

**Step 2 — raw POST of bytes**: `web-api/dist/WebClient.js:425-448`:
```js
const uploadRes = yield this.makeRequest(upload_url, { body }, headers);   // :436-438
if (uploadRes.status !== 200) { return Promise.reject(Error(`Failed to upload file ...`)); }  // :439-441
```
* HTTP POST (all `makeRequest` calls are POST).
* Because `body` is a Buffer, `serializeApiCallData` takes the binary path
  (`web-api/dist/WebClient.js:575-577`, `:586-622`), so the wire format is
  **`multipart/form-data` with a single part named `body`**, filename `Untitled`
  (default at `web-api/dist/WebClient.js:116`, chosen at `:591-605` because a Buffer has
  no `.name`/`.path`).
* `Authorization: Bearer <token>` only when `options.token` was passed
  (`web-api/dist/WebClient.js:434-435`).
* The mock MUST answer HTTP **200**. The body content is ignored except that
  `uploadRes.data` is echoed into an unused return value at `:442`.
* Note that `makeRequest` applies the same retry policy here, so a non-200 upload also
  retries.

**Step 3 — `files.completeUploadExternal`**: `web-api/dist/WebClient.js:414-419`.
Uploads are GROUPED by `channel_id` + `thread_ts` + `initial_comment` +
`JSON.stringify(blocks)` (`web-api/dist/file-upload.js:208-245`, key at `:213`), and each
group becomes one call with:
`{files: [{id, title}, ...], channel_id, blocks, initial_comment}` (`:216-221`)
plus `{channel_id, thread_ts}` when a `thread_ts` is present with a `channel_id`
(`:222-228`) and `token` when present (`:229-231`).
Arg type: `web-api/dist/types/request/files.d.ts:54-68`;
`FileUploadComplete` is `{id, title?}` at `:28-33`.

**Return shape**: `{ok: true, files: <array of FilesCompleteUploadExternalResponse>}`
(`web-api/dist/WebClient.js:384`). Each element is
`{ok, files: File[], error?, response_metadata?}`
(`web-api/dist/types/response/FilesCompleteUploadExternalResponse.d.ts:2-9`), so the
caller sees `{ok:true, files:[{ok:true, files:[{id,...}]}]}`.

**No `files.info` polling.** Grep for `files.info` / `filesInfo` in
`web-api/dist/WebClient.js` and `web-api/dist/file-upload.js` returns nothing.

Aliasing note: `channel_id` is taken from `options.channels ?? options.channel_id`
(`web-api/dist/file-upload.js:52`), and `title` defaults to
`options.title ?? options.filename ?? <derived name>` (`:56`).

---

## I. TYPES — where the wire shapes live

| Shape | File | Line |
| --- | --- | --- |
| Socket Mode client options (incl. `clientOptions`) | `socket-mode/dist/src/SocketModeOptions.d.ts` | 3-46 |
| `SlackWebSocketOptions` (ping/pong config) | `socket-mode/dist/src/SlackWebSocket.d.ts` | 5-30 |
| Unrecoverable start errors | `socket-mode/dist/src/UnrecoverableSocketModeStartError.js` | 8-12 |
| Bolt `ReceiverEvent` (the envelope Bolt actually consumes) | `bolt/dist/types/receiver.d.ts` | 4-10 |
| Events API outer envelope (`event_callback`) | `bolt/dist/types/events/index.d.ts` | 41-59 |
| `Authorization` entry inside `authorizations[]` | `bolt/dist/types/events/index.d.ts` | 53-59 |
| `SlashCommand` | `bolt/dist/types/command/index.d.ts` | 18-34 |
| `BlockAction` | `bolt/dist/types/actions/block-action.d.ts` | 206-252 |
| `BlockElementAction` union (button, selects, overflow, ...) | `bolt/dist/types/actions/block-action.d.ts` | 10 |
| `ButtonAction` | `bolt/dist/types/actions/block-action.d.ts` | 26-31 |
| `ViewSubmitAction` / `ViewClosedAction` | `bolt/dist/types/view/index.d.ts` | 37, 66 |
| `ViewOutput` | `bolt/dist/types/view/index.d.ts` | 266 |
| `GenericMessageEvent` | `@slack/types/dist/events/message.d.ts` | 7-37 |
| `BotMessageEvent` | `@slack/types/dist/events/message.d.ts` | 38-47 |
| `AllMessageEvents` union | `@slack/types/dist/events/message.d.ts` | 5 |
| `AssistantThreadStartedEvent` | `@slack/types/dist/events/assistant.d.ts` | 1-14 |
| `AssistantThreadContextChangedEvent` | `@slack/types/dist/events/assistant.d.ts` | 15-28 |
| `AuthTestResponse` | `web-api/dist/types/response/AuthTestResponse.d.ts` | 2-18 |
| `AppsConnectionsOpenResponse` | `web-api/dist/types/response/AppsConnectionsOpenResponse.d.ts` | 2-8 |
| `FilesGetUploadURLExternalResponse` | `web-api/dist/types/response/FilesGetUploadURLExternalResponse.d.ts` | 2-13 |
| `FilesCompleteUploadExternalResponse` | `web-api/dist/types/response/FilesCompleteUploadExternalResponse.d.ts` | 2-9 |
| `FilesCompleteUploadExternalArguments` | `web-api/dist/types/request/files.d.ts` | 54-68 |
| `FilesGetUploadURLExternalArguments` | `web-api/dist/types/request/files.d.ts` | 71-80 |
| `AssistantThreads*Arguments` | `web-api/dist/types/request/assistant.d.ts` | 2-35 |
| `WebClientOptions` (incl. `slackApiUrl`) | `web-api/dist/WebClient.d.ts` | 18, 162 |
| `LogLevel` enum | `logger/dist/index.js` | 8-14 |

(All paths are relative to `/Users/taras/Documents/code/agent-swarm/node_modules/@slack/`.)

---

## Derived mock requirements

### HTTP surface (base `http://127.0.0.1:PORT/api/`)

1. `POST /api/auth.test` — bot token in `Authorization: Bearer`. Must be live BEFORE
   `new App()` returns. Return `{ok:true, url, team, user, team_id, user_id, bot_id,
   is_enterprise_install:false}`.
2. `POST /api/apps.connections.open` — app (xapp-) token. Return
   `{ok:true, url:"ws://127.0.0.1:PORT/link?ticket=<id>"}`.
3. `POST /api/<method>` for every method agent-swarm uses:
   `chat.postMessage`, `chat.update`, `chat.delete`, `reactions.add`,
   `conversations.replies`, `assistant.threads.setStatus`,
   `assistant.threads.setTitle`, `assistant.threads.setSuggestedPrompts`,
   `files.getUploadURLExternal`, `files.completeUploadExternal`.
4. `POST <upload_url>` — a raw upload endpoint outside `/api/`.
5. `POST <response_url>` — Bolt's `respond()` posts there with its OWN axios instance,
   bypassing `WebClient` entirely (`bolt/dist/App.js:632-637` wires it,
   `:974-978` implements it). That instance is created at `bolt/dist/App.js:134-143`
   with no `baseURL`, no `Authorization`, and no `Content-Type` override, so axios 1.x
   serialises the object as **`application/json`**, NOT form-urlencoded. A string
   argument becomes `{text: "..."}` (`:976`). The mock must issue `response_url`s that
   point at itself and must parse JSON on that route.
6. Body parsing: `application/x-www-form-urlencoded`; `JSON.parse` the
   `blocks`/`attachments`/`metadata`/`files` fields. Multipart for uploads (single part
   named `body`).
7. Always HTTP 200. Errors as `{"ok":false,"error":"..."}`. Every response needs `ok`.
   No redirects. No gzip unless the test wants it.
8. Use 429 + `Retry-After` only in dedicated rate-limit tests; anything else is a retry
   storm (up to 100 attempts on the listener client).

### WebSocket surface

9. Accept the upgrade at the exact path returned by `apps.connections.open`. No
   Authorization header will be sent, so authenticate via the URL.
10. Do not require a subprotocol. Do not require permessage-deflate.
11. Send `{"type":"hello","num_connections":1,"debug_info":{...},
    "connection_info":{"app_id":"A..."}}` immediately after upgrade. Only `type` is read,
    but `app.start()` blocks forever without it.
12. Reply to client PING frames with PONG frames. Budget: the first pong within ~6.6 s of
    open, and thereafter at least one pong every 5 s.
13. Either never send server PING frames, or send them on a stable interval well under
    30 s. A single ping followed by silence kills the connection 30 s later.
14. Envelopes: `{"envelope_id":"<uuid>","type":"events_api|interactive|slash_commands",
    "accepts_response_payload":<bool>,"retry_attempt":0,"retry_reason":"","payload":{...}}`.
    Payload shape is what actually drives Bolt's routing.
15. Read acks: `{"envelope_id":"<id>","payload":{...}}`. `payload` is always present.
    Track pending envelope ids so tests can assert acks and simulate retries.
16. Expect an instantaneous ack for `events_api` (Bolt acks before listeners) and a
    listener-driven ack for `slash_commands` / `interactive` with the response body inside
    `payload`.
17. `{"type":"disconnect","reason":"<anything>"}` triggers a client-side close. Reason is
    ignored. Expect a reconnect via a fresh `apps.connections.open` after
    5 s x attempt-number.
18. On `app.stop()` expect a close frame with code 1000, and do not rely on
    `await app.stop()` meaning the socket is already gone.

### Payload rules

19. Do not echo the bot's own messages back with `subtype:'bot_message'` and the bot's
    `bot_id`, nor any event with `user === <auth.test user_id>` (except
    `member_joined_channel` / `member_left_channel`). `ignoreSelf` drops them.
20. Assistant thread messages need `channel_type:'im'`, a `thread_ts` key, and no
    `subtype` (or `'file_share'`) to reach `userMessage` instead of `app.message`.
21. `conversations.replies` with `include_all_metadata=true` must return the bot's root
    message with `user` equal to the `auth.test` `user_id` and with NO `subtype` key at
    all, and must echo stored `metadata`, otherwise the assistant thread context store is
    a no-op.
22. `files.getUploadURLExternal` must return an absolute `upload_url` and a `file_id`;
    the upload endpoint must answer HTTP 200; `files.completeUploadExternal` receives
    `files` as a JSON-encoded string field.

### agent-swarm code change required

23. Add `clientOptions: { slackApiUrl: process.env.SLACK_API_URL ?? 'https://slack.com/api/' }`
    to the `new App({...})` at
    `/Users/taras/Documents/code/agent-swarm/src/slack/app.ts:44`. That single option
    redirects both the bot client and the socket-mode client. No library env var exists.
