export type TransportKind = "token_delta" | "part_update" | "message_poll_fallback";

export interface EventMeta {
  sessionID: string;
  messageID?: string;
  partID?: string;
  model?: string;
  provider?: string;
  project?: string;
  directory?: string;
  transport: TransportKind;
  receivedAt: number;
}

export type WatchdogEvent =
  | ({ kind: "assistantTextDelta"; delta: string } & EventMeta)
  | ({ kind: "assistantTextSnapshot"; text: string } & EventMeta)
  | ({ kind: "reasoningTextDelta"; delta: string } & EventMeta)
  | ({ kind: "reasoningTextSnapshot"; text: string } & EventMeta)
  | ({ kind: "toolCallStarted"; callID: string; tool: string; input: unknown } & EventMeta)
  | ({ kind: "toolCallUpdated"; callID: string; tool: string; inputDelta: string } & EventMeta)
  | ({
      kind: "toolCallFinished";
      callID: string;
      tool: string;
      outcome: "success" | "error";
      errorMessage?: string;
    } & EventMeta)
  | ({ kind: "toolOutputObserved"; callID: string; tool: string; outcomeText?: string } & EventMeta)
  | ({ kind: "sessionCreated" } & EventMeta)
  | ({ kind: "sessionBusy" } & EventMeta)
  | ({ kind: "sessionIdle" } & EventMeta)
  | ({ kind: "sessionError"; error?: string } & EventMeta)
  | ({ kind: "sessionAborted" } & EventMeta)
  | ({ kind: "fileChangeObserved"; path?: string } & EventMeta)
  | ({ kind: "progressObserved"; marker: string } & EventMeta)
  | ({ kind: "sessionMetaObserved"; title?: string } & EventMeta);

export function isSessionEvent(e: WatchdogEvent): boolean {
  return typeof e.sessionID === "string" && e.sessionID.length > 0;
}