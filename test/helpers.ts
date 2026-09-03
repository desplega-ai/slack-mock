import { App, LogLevel } from "@slack/bolt";
import type { SlackMock } from "../src/index.ts";

export function appFor(mock: SlackMock): App {
  return new App({
    token: mock.env.SLACK_BOT_TOKEN,
    appToken: mock.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.ERROR,
    clientOptions: { slackApiUrl: mock.env.SLACK_API_URL },
  });
}

export function errorCode(error: unknown): string {
  return (error as { data: { error: string } }).data.error;
}

export async function rejected(promise: Promise<unknown>): Promise<unknown> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  if (error === undefined) throw new Error("expected Slack API call to reject");
  return error;
}
