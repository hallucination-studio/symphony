import type { JsonValue } from "@symphony/contracts";

type JsonRecord = { [key: string]: JsonValue };

export type PerformerEventKind =
  | "turn_started"
  | "progress"
  | "warning_raised"
  | "error_raised"
  | "usage_updated"
  | "turn_completed"
  | "heartbeat";

interface TurnObservationBase {
  turnId: string;
  rootIssueId: string;
  workIssueId?: string;
  sequence: number;
  eventKind: PerformerEventKind;
}

export interface TurnEventObservation extends TurnObservationBase {
  observationKind: "event";
  code?: string;
  retryable?: boolean;
  sanitizedReason?: string;
}

export type TurnObservationFailureCode =
  | "turn_event_log_failed"
  | "turn_event_projection_failed";

export interface TurnObservationFailure extends TurnObservationBase {
  observationKind: "failure";
  failureCode: TurnObservationFailureCode;
  sanitizedReason: string;
}

export type TurnObservation = TurnEventObservation | TurnObservationFailure;

export type TurnEventProjection =
  | {
      kind: "status";
      turnStatus: string;
      occurredAt: string;
    }
  | {
      kind: "timeline";
      eventKey: string;
      body: string;
    };

export function performerTurnObservation(value: JsonValue): {
  observation: TurnEventObservation;
  projection: TurnEventProjection;
} {
  const event = requiredRecord(value, "performer_event_invalid");
  const body = requiredRecord(event.body, "performer_event_body_invalid");
  const turnId = requiredString(event.turn_id, "performer_event_turn_id_invalid");
  const rootIssueId = requiredString(
    event.root_issue_id,
    "performer_event_root_id_invalid",
  );
  const sequence = nonNegativeInteger(
    event.sequence,
    "performer_event_sequence_invalid",
  );
  const eventKind = performerEventKind(body.kind);
  const workIssueId = optionalString(event.work_issue_id);
  const common = {
    turnId,
    rootIssueId,
    ...(workIssueId ? { workIssueId } : {}),
    sequence,
    eventKind,
  };

  if (
    eventKind === "turn_started" ||
    eventKind === "progress" ||
    eventKind === "usage_updated" ||
    eventKind === "heartbeat"
  ) {
    return {
      observation: { observationKind: "event", ...common },
      projection: {
        kind: "status",
        turnStatus: eventKind === "progress"
          ? requiredString(body.stage, "performer_progress_stage_invalid")
          : eventKind,
        occurredAt: requiredString(
          event.occurred_at,
          "performer_event_timestamp_invalid",
        ),
      },
    };
  }

  const details = timelineDetails(eventKind, body);
  const eventKey = `${turnId}:${sequence}`;
  return {
    observation: {
      observationKind: "event",
      ...common,
      code: details.code,
      ...(details.retryable === undefined
        ? {}
        : { retryable: details.retryable }),
      sanitizedReason: details.summary.slice(0, 1_000),
    },
    projection: {
      kind: "timeline",
      eventKey,
      body: [
        details.heading,
        "",
        details.summary.slice(0, 15_000),
        ...(details.retryable === undefined
          ? []
          : ["", `Retryable: ${details.retryable ? "yes" : "no"}`]),
        "",
        "<!-- symphony turn event",
        `event_key: ${eventKey}`,
        "-->",
      ].join("\n"),
    },
  };
}

export function turnObservationFailure(
  observation: TurnEventObservation,
  failureCode: TurnObservationFailureCode,
  sanitizedReason: string,
): TurnObservationFailure {
  return {
    observationKind: "failure",
    turnId: observation.turnId,
    rootIssueId: observation.rootIssueId,
    ...(observation.workIssueId
      ? { workIssueId: observation.workIssueId }
      : {}),
    sequence: observation.sequence,
    eventKind: observation.eventKind,
    failureCode,
    sanitizedReason,
  };
}

function timelineDetails(eventKind: PerformerEventKind, body: JsonRecord) {
  if (eventKind === "warning_raised") {
    const code = requiredString(
      body.warning_code,
      "performer_warning_code_invalid",
    );
    return {
      code,
      heading: `**Performer warning (${code})**`,
      summary: requiredString(
        body.sanitized_summary,
        "performer_event_summary_invalid",
      ),
    };
  }
  if (eventKind === "error_raised") {
    const code = requiredString(body.error_code, "performer_error_code_invalid");
    return {
      code,
      heading: `**Performer error (${code})**`,
      summary: requiredString(
        body.sanitized_summary,
        "performer_event_summary_invalid",
      ),
      retryable: body.retryable === true,
    };
  }
  if (eventKind === "turn_completed") {
    const code = requiredString(
      body.result_kind,
      "performer_result_kind_invalid",
    );
    return {
      code,
      heading: `**Performer Turn completed (${code})**`,
      summary: requiredString(
        body.sanitized_summary,
        "performer_event_summary_invalid",
      ),
    };
  }
  throw new Error("performer_event_kind_invalid");
}

function performerEventKind(value: JsonValue | undefined): PerformerEventKind {
  if (
    value === "turn_started" ||
    value === "progress" ||
    value === "warning_raised" ||
    value === "error_raised" ||
    value === "usage_updated" ||
    value === "turn_completed" ||
    value === "heartbeat"
  ) {
    return value;
  }
  throw new Error("performer_event_kind_invalid");
}

function requiredRecord(value: JsonValue | undefined, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}

function requiredString(value: JsonValue | undefined, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: JsonValue | undefined, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}
