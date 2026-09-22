import type { EventMeta, TransportKind, WatchdogEvent } from "../../core/events/types.js";

type RawEvent = Record<string, unknown>;

function bytesNow(): number {
  return Date.now();
}

function extractProps(raw: RawEvent): RawEvent {
  if (raw && typeof raw === "object") {
    const props = (raw as { properties?: unknown }).properties;
    if (props && typeof props === "object") return props as RawEvent;
    const data = (raw as { data?: unknown }).data;
    if (data && typeof data === "object") return data as RawEvent;
    const payload = (raw as { payload?: unknown }).payload;
    if (payload && typeof payload === "object") {
      const inner = payload as RawEvent;
      if (typeof inner.properties === "object") return inner.properties as RawEvent;
      if (typeof inner.data === "object") return inner.data as RawEvent;
      return inner;
    }
  }
  return raw ?? {};
}

function metaFrom(raw: RawEvent, props: RawEvent, transport: TransportKind): EventMeta {
  const sessionID = str(props.sessionID) ?? str(raw.sessionID) ?? "";
  const partID = str(props.partID) ?? str((props.part as { id?: unknown } | undefined)?.id) ?? undefined;
  const messageID = str(props.messageID) ?? undefined;
  return {
    sessionID,
    partID,
    messageID,
    transport,
    receivedAt: bytesNow(),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.value === "string") return o.value;
    if (typeof o.delta === "string") return o.delta;
  }
  return undefined;
}

export function normalizeOpenCodeEvent(raw: unknown, transport: TransportKind): WatchdogEvent | WatchdogEvent[] | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as RawEvent;
  const type = str(outer.type) ?? str((outer.payload as RawEvent | undefined)?.type);
  if (!type) return null;
  const props = extractProps(outer);
  const meta = metaFrom(outer, props, transport);

  switch (type) {
    case "server.connected":
    case "server.disconnected":
      return null;

    case "message.part.delta": {
      const field = str(props.field);
      const delta = textOf(props.delta);
      if (!delta || delta.length === 0) return null;
      if (field === "reasoning") return { kind: "reasoningTextDelta", delta, ...meta };
      return { kind: "assistantTextDelta", delta, ...meta };
    }

    case "message.part.updated":
      return normalizePartUpdated(props, meta);

    case "session.status": {
      const status = props.status as RawEvent | undefined;
      const stype = str(status?.type) ?? str(props.type);
      if (stype === "idle") return { kind: "sessionIdle", ...meta };
      if (stype === "busy") return { kind: "sessionBusy", ...meta };
      if (stype === "retry") return { kind: "progressObserved", marker: "session.retry", ...meta };
      return null;
    }

    case "session.created":
      return { kind: "sessionCreated", ...meta };

    case "session.aborted":
      return { kind: "sessionAborted", ...meta };

    case "session.error": {
      const error = str(props.error) ?? str(props.message);
      return { kind: "sessionError", error, ...meta };
    }

    case "file.edited":
      return { kind: "fileChangeObserved", path: str(props.path), ...meta };

    case "message.updated":
    case "message.snapshot":
      return { kind: "progressObserved", marker: "message.updated", ...meta };

    case "session.next.text.delta": {
      const delta = textOf(props.delta) ?? textOf(props.text);
      if (!delta || delta.length === 0) return null;
      return { kind: "assistantTextDelta", delta, ...meta };
    }

    case "session.next.text.started":
      return { kind: "progressObserved", marker: "text.started", ...meta };

    case "session.next.text.ended": {
      const text = textOf(props.text) ?? textOf(props.snapshot);
      if (!text) return { kind: "progressObserved", marker: "text.ended", ...meta };
      return { kind: "assistantTextSnapshot", text, ...meta };
    }

    case "session.next.reasoning.delta": {
      const delta = textOf(props.delta) ?? textOf(props.text);
      if (!delta || delta.length === 0) return null;
      return { kind: "reasoningTextDelta", delta, ...meta };
    }

    case "session.next.reasoning.ended": {
      const text = textOf(props.text) ?? textOf(props.snapshot);
      if (!text) return null;
      return { kind: "reasoningTextSnapshot", text, ...meta };
    }

    case "session.next.tool.called": {
      const callID = str(props.toolCallID) ?? str(props.callID) ?? meta.partID ?? "";
      const tool = str(props.name) ?? str(props.tool) ?? "tool";
      return { kind: "toolCallStarted", callID, tool, input: props.input, ...meta };
    }

    case "session.next.tool.input.delta": {
      const callID = str(props.toolCallID) ?? str(props.callID) ?? meta.partID ?? "";
      const tool = str(props.name) ?? str(props.tool) ?? "tool";
      const inputDelta = str(props.inputDelta) ?? textOf(props.input) ?? "";
      return { kind: "toolCallUpdated", callID, tool, inputDelta, ...meta };
    }

    case "session.next.tool.success": {
      const callID = str(props.toolCallID) ?? str(props.callID) ?? meta.partID ?? "";
      const tool = str(props.name) ?? str(props.tool) ?? "tool";
      const outcomeText = textOf(props.output);
      return [
        { kind: "toolCallFinished", callID, tool, outcome: "success", ...meta },
        ...(outcomeText ? [{ kind: "toolOutputObserved", callID, tool, outcomeText, ...meta } as WatchdogEvent] : []),
      ];
    }

    case "session.next.tool.failed": {
      const callID = str(props.toolCallID) ?? str(props.callID) ?? meta.partID ?? "";
      const tool = str(props.name) ?? str(props.tool) ?? "tool";
      const errorMessage = str(props.error) ?? str(props.message);
      return { kind: "toolCallFinished", callID, tool, outcome: "error", errorMessage, ...meta };
    }

    case "session.next.step.started":
    case "session.next.step.ended":
      return { kind: "progressObserved", marker: type.replace("session.next.", ""), ...meta };

    case "session.next.retried":
    case "session.next.synthetic":
    case "session.next.prompted":
      return { kind: "progressObserved", marker: type.replace("session.next.", ""), ...meta };
  }
  return null;
}

function normalizePartUpdated(props: RawEvent, meta: EventMeta): WatchdogEvent | WatchdogEvent[] | null {
  const part = props.part as RawEvent | undefined;
  if (!part) return null;
  const ptype = str(part.type);
  switch (ptype) {
    case "text": {
      const text = str(part.text);
      if (!text) return null;
      return { kind: "assistantTextSnapshot", text, ...meta };
    }
    case "reasoning": {
      const text = str(part.text);
      if (!text) return null;
      return { kind: "reasoningTextSnapshot", text, ...meta };
    }
    case "step-start":
      return { kind: "progressObserved", marker: "step.start", ...meta };
    case "step-finish":
      return { kind: "progressObserved", marker: "step.end", ...meta };
    case "tool": {
      const callID = str(part.callID) ?? "";
      const tool = str(part.tool) ?? "tool";
      const state = part.state as RawEvent | undefined;
      const stype = str(state?.type);
      const input = state?.input;
      const output = str(state?.output);
      const build: WatchdogEvent = { kind: "progressObserved", marker: "tool.part", ...meta };
      if (stype === "running" || stype === "pending" || stype === "input") {
        return { kind: "toolCallStarted", callID, tool, input, ...meta };
      }
      if (stype === "complete" || stype === "error" || stype === "cancelled") {
        const outcome: "success" | "error" = stype === "error" || stype === "cancelled" ? "error" : "success";
        const finished: WatchdogEvent = { kind: "toolCallFinished", callID, tool, outcome, ...meta };
        if (outcome === "success" && output) {
          return [finished, { kind: "toolOutputObserved", callID, tool, outcomeText: output, ...meta }];
        }
        return finished;
      }
      return build;
    }
  }
  return null;
}