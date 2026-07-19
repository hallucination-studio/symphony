import assert from "node:assert/strict";
import test from "node:test";
import {
  PerformerEventStreamDecoder,
  type DecodedPerformerTurnEvent,
  type PerformerEventStreamViolation,
} from "../internal/PerformerEventStreamDecoder.js";

const encoder = new TextEncoder();

test("Performer event stream preserves split Unicode and ordered frames", () => {
  const events: DecodedPerformerTurnEvent[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const decoder = createDecoder(events, violations);
  const first = frame(0, {
    kind: "warning_raised",
    warning_code: "provider_degraded",
    sanitized_summary: "Provider 正在恢复.",
  });
  const second = frame(1, { kind: "heartbeat" });
  const splitAt = first.indexOf(encoder.encode("正")[0]!) + 1;

  decoder.write(first.subarray(0, splitAt));
  decoder.write(concat(first.subarray(splitAt), second));
  decoder.end();

  assert.deepEqual(events.map(({ sequence }) => sequence), [0, 1]);
  assert.equal(
    (events[0]!.body as { sanitized_summary: string }).sanitized_summary,
    "Provider 正在恢复.",
  );
  assert.deepEqual(violations, []);
});

test("Performer event stream drops invalid frames and resumes at the expected sequence", () => {
  const events: DecodedPerformerTurnEvent[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const decoder = createDecoder(events, violations);
  const wrongTurn = event(0, { kind: "turn_started" });
  wrongTurn.turn_id = "turn-other";

  decoder.write(Uint8Array.of(0xff, 0x0a));
  decoder.write(encoder.encode("not-json\n"));
  decoder.write(encoder.encode(`${JSON.stringify(wrongTurn)}\n`));
  decoder.write(frame(0, { kind: "turn_started" }));
  decoder.end();

  assert.deepEqual(events.map(({ sequence }) => sequence), [0]);
  assert.deepEqual(
    violations.map(({ code, expected_sequence, frame_index }) => ({
      code,
      expected_sequence,
      frame_index,
    })),
    [
      {
        code: "performer_event_contract_invalid",
        expected_sequence: 0,
        frame_index: 0,
      },
      {
        code: "performer_event_contract_invalid",
        expected_sequence: 0,
        frame_index: 1,
      },
      {
        code: "performer_event_correlation_invalid",
        expected_sequence: 0,
        frame_index: 2,
      },
    ],
  );
  assert.ok(violations.every(({ turn_id, root_issue_id }) =>
    turn_id === "turn-1" && root_issue_id === "root-1"));
});

test("Performer event stream checks every correlation field", () => {
  const mismatches = [
    { turn_id: "turn-other" },
    { root_issue_id: "root-other" },
    { work_issue_id: "work-other" },
    { sequence: 1 },
  ];

  for (const mismatch of mismatches) {
    const events: DecodedPerformerTurnEvent[] = [];
    const violations: PerformerEventStreamViolation[] = [];
    const decoder = new PerformerEventStreamDecoder({
      turnId: "turn-1",
      rootIssueId: "root-1",
      workIssueId: "work-1",
      sequenceStart: 0,
      onEvent: (value) => events.push(value),
      onViolation: (value) => violations.push(value),
    });
    const value = {
      ...event(0, { kind: "heartbeat" }),
      work_issue_id: "work-1",
      ...mismatch,
    };

    decoder.write(encoder.encode(`${JSON.stringify(value)}\n`));
    decoder.end();

    assert.deepEqual(events, []);
    assert.deepEqual(violations.map(({ code }) => code), [
      "performer_event_correlation_invalid",
    ]);
  }
});

test("Performer event stream bounds one frame and recovers after its newline", () => {
  const events: DecodedPerformerTurnEvent[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const decoder = createDecoder(events, violations);

  decoder.write(new Uint8Array(65_537).fill(97));
  decoder.write(concat(encoder.encode("\n"), frame(0, { kind: "heartbeat" })));
  decoder.end();

  assert.deepEqual(events.map(({ sequence }) => sequence), [0]);
  assert.deepEqual(violations.map(({ code }) => code), [
    "performer_event_stream_frame_bytes_exceeded",
  ]);
});

test("Performer event stream bounds total input bytes", () => {
  const events: DecodedPerformerTurnEvent[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const decoder = createDecoder(events, violations);

  decoder.write(new Uint8Array(1_048_577));
  decoder.write(frame(0, { kind: "heartbeat" }));
  decoder.end();

  assert.deepEqual(events, []);
  assert.deepEqual(violations.map(({ code }) => code), [
    "performer_event_stream_total_bytes_exceeded",
  ]);
});

test("Performer event stream bounds frame count", () => {
  const events: DecodedPerformerTurnEvent[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const decoder = createDecoder(events, violations);

  for (let sequence = 0; sequence <= 4_096; sequence += 1) {
    decoder.write(frame(sequence, { kind: "heartbeat" }));
  }
  decoder.end();

  assert.equal(events.length, 4_096);
  assert.deepEqual(violations.map(({ code }) => code), [
    "performer_event_stream_frame_count_exceeded",
  ]);
});

test("Performer event stream reports an incomplete terminal frame", () => {
  const events: DecodedPerformerTurnEvent[] = [];
  const violations: PerformerEventStreamViolation[] = [];
  const decoder = createDecoder(events, violations);

  decoder.write(encoder.encode(JSON.stringify(event(0, { kind: "heartbeat" }))));
  decoder.end();

  assert.deepEqual(events, []);
  assert.deepEqual(violations.map(({ code }) => code), [
    "performer_event_stream_frame_incomplete",
  ]);
});

function createDecoder(
  events: DecodedPerformerTurnEvent[],
  violations: PerformerEventStreamViolation[],
): PerformerEventStreamDecoder {
  return new PerformerEventStreamDecoder({
    turnId: "turn-1",
    rootIssueId: "root-1",
    sequenceStart: 0,
    onEvent: (value) => events.push(value),
    onViolation: (value) => violations.push(value),
  });
}

function frame(
  sequence: number,
  body: { [key: string]: string | boolean },
): Uint8Array {
  return encoder.encode(`${JSON.stringify(event(sequence, body))}\n`);
}

function event(
  sequence: number,
  body: { [key: string]: string | boolean },
): {
  [key: string]: string | number | { [key: string]: string | boolean };
} {
  return {
    protocol_version: "1",
    turn_id: "turn-1",
    root_issue_id: "root-1",
    sequence,
    occurred_at: "2026-07-17T00:00:01Z",
    body,
  };
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
