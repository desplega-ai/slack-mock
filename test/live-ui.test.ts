import { afterAll, beforeAll, expect, test } from "bun:test";
import { SlackMock } from "../src/index.ts";

let mock: SlackMock;
beforeAll(async () => {
  mock = await SlackMock.start({ port: 0 });
});
afterAll(async () => {
  await mock.stop();
});

async function streamOf(url: string): Promise<{
  readUntil: (marker: string) => Promise<string>;
  close: () => void;
}> {
  const ac = new AbortController();
  const res = await fetch(url, { signal: ac.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    readUntil: async (marker: string) => {
      const deadline = Date.now() + 5000;
      while (!buf.includes(marker)) {
        if (Date.now() > deadline) throw new Error(`no ${marker} within 5s; got: ${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      return buf;
    },
    close: () => ac.abort(),
  };
}

test("channel pages tag messages with data-ts and enable the live script by default", async () => {
  const posted = await mock.postMessage({ channel: "general", text: "first" });
  const html = await (await fetch(`${mock.baseUrl}/c/general`)).text();
  expect(html).toContain(`data-ts="${posted.ts}"`);
  expect(html).toContain("LIVE=true");
  expect(html).toContain("/events");
  const off = await (await fetch(`${mock.baseUrl}/c/general?live=0`)).text();
  expect(off).toContain("LIVE=false");
  const polling = await (await fetch(`${mock.baseUrl}/c/general?refresh=2`)).text();
  expect(polling).toContain("LIVE=false");
  expect(polling).toContain('http-equiv="refresh"');
});

test("/c/<channel>/events streams a change when a message lands in that channel", async () => {
  const s = await streamOf(`${mock.baseUrl}/c/general/events`);
  try {
    await s.readUntil("event: hello");
    const general = mock.store.channelByName("general")!;
    mock.addChannel({ name: "elsewhere" });
    await mock.postMessage({ channel: "elsewhere", text: "not for general" });
    const posted = await mock.postMessage({ channel: "general", text: "live one" });
    const buf = await s.readUntil("event: change");
    const first = buf.split("event: change")[1]!.split("\n\n")[0]!;
    expect(first).toContain('"kind":"message.add"');
    expect(first).toContain(`"channel":"${general.id}"`);
    expect(first).toContain(`"ts":"${posted.ts}"`);
    expect(buf).not.toContain("not for general");
  } finally {
    s.close();
  }
});

test("events for an unknown channel are a 404", async () => {
  expect((await fetch(`${mock.baseUrl}/c/nope/events`)).status).toBe(404);
});
