import { errorMessage } from './redactError';
import { ErrorSchema } from '../../types/ws-events';
import { summarizeWsClose } from '../../services/messaging/wsEventBudget';

type ServerErrorPayload = {
  code?: unknown;
  channel_id?: unknown;
  current_epoch?: unknown;
  event_class?: unknown;
  retry_after_ms?: unknown;
};

export type WsDiagnosticSummary = {
  type: string;
  event?: string;
  code?: string | number;
  reason?: string;
  message?: string;
  channelId?: string;
  currentEpoch?: number;
  eventClass?: string;
  retryAfterMs?: number;
};

export function summarizeWsDiagnostic(value: unknown): WsDiagnosticSummary {
  if (value instanceof CloseEvent) {
    return {
      type: 'CloseEvent',
      event: value.type,
      ...summarizeWsClose(value.code, value.reason),
    };
  }

  if (value instanceof Error) {
    return {
      type: value.name || 'Error',
      message: errorMessage(value),
    };
  }

  if (value instanceof Event) {
    return {
      type: value.constructor.name || 'Event',
      event: value.type,
    };
  }

  return {
    type: typeof value,
  };
}

export function summarizeWsServerError(data: ServerErrorPayload): WsDiagnosticSummary {
  const code = typeof data.code === 'string' && data.code ? data.code : 'unknown';
  if (code === 'ws_rate_limited') {
    // This helper also has callers outside the validated dispatch boundary.
    // Validate only the bounded pair; no arbitrary fields reach this summary.
    const parsed = ErrorSchema.safeParse({
      type: 'error',
      data: { code, event_class: data.event_class, retry_after_ms: data.retry_after_ms },
    });
    return {
      type: 'server_error',
      code,
      ...(parsed.success
        ? {
            eventClass: parsed.data.data.event_class,
            retryAfterMs: parsed.data.data.retry_after_ms,
          }
        : {}),
    };
  }
  return {
    type: 'server_error',
    code,
    ...(typeof data.channel_id === 'string' ? { channelId: data.channel_id } : {}),
    ...(typeof data.current_epoch === 'number' ? { currentEpoch: data.current_epoch } : {}),
  };
}
