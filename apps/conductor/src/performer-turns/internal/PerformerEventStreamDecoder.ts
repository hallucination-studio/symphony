import {
  decodeConductorPerformerPerformerTurnEvent,
  type JsonValue,
} from "@symphony/contracts";
import { Buffer } from "node:buffer";

const MAX_TOTAL_BYTES = 1_048_576;
const MAX_FRAME_BYTES = 65_536;
const MAX_FRAME_COUNT = 4_096;

type JsonRecord = { [key: string]: JsonValue };

export type DecodedPerformerTurnEvent = Readonly<JsonRecord>;

export type PerformerEventStreamViolationCode =
  | "performer_event_stream_total_bytes_exceeded"
  | "performer_event_stream_frame_bytes_exceeded"
  | "performer_event_stream_frame_count_exceeded"
  | "performer_event_stream_frame_incomplete"
  | "performer_event_contract_invalid"
  | "performer_event_correlation_invalid";

export interface PerformerEventStreamViolation {
  code: PerformerEventStreamViolationCode;
  turn_id: string;
  root_issue_id: string;
  work_issue_id?: string;
  expected_sequence: number;
  frame_index: number;
}

export interface PerformerEventStreamDecoderOptions {
  turnId: string;
  rootIssueId: string;
  workIssueId?: string;
  sequenceStart: number;
  onEvent(event: DecodedPerformerTurnEvent): void;
  onViolation(violation: PerformerEventStreamViolation): void;
}

export class PerformerEventStreamDecoder {
  readonly #textDecoder = new TextDecoder("utf-8", { fatal: true });
  readonly #frameChunks: Buffer[] = [];
  #totalBytes = 0;
  #frameBytes = 0;
  #frameIndex = 0;
  #expectedSequence: number;
  #discardingFrame = false;
  #stopped = false;
  #ended = false;

  constructor(private readonly options: PerformerEventStreamDecoderOptions) {
    this.#expectedSequence = options.sequenceStart;
  }

  write(chunk: Uint8Array): void {
    if (this.#ended || this.#stopped || chunk.byteLength === 0) return;
    if (this.#totalBytes + chunk.byteLength > MAX_TOTAL_BYTES) {
      this.#stop("performer_event_stream_total_bytes_exceeded");
      return;
    }
    this.#totalBytes += chunk.byteLength;

    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      this.#append(chunk.subarray(start, index));
      this.#completeFrame();
      if (this.#stopped) return;
      start = index + 1;
    }
    this.#append(chunk.subarray(start));
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#stopped || this.#discardingFrame) return;
    if (this.#frameBytes > 0) {
      this.#report("performer_event_stream_frame_incomplete");
      this.#resetFrame();
    }
  }

  #append(bytes: Uint8Array): void {
    if (this.#discardingFrame || bytes.byteLength === 0) return;
    if (this.#frameBytes + bytes.byteLength > MAX_FRAME_BYTES) {
      this.#report("performer_event_stream_frame_bytes_exceeded");
      this.#resetFrame();
      this.#discardingFrame = true;
      return;
    }
    this.#frameChunks.push(Buffer.from(bytes));
    this.#frameBytes += bytes.byteLength;
  }

  #completeFrame(): void {
    if (this.#frameIndex >= MAX_FRAME_COUNT) {
      this.#stop("performer_event_stream_frame_count_exceeded");
      return;
    }
    this.#frameIndex += 1;
    if (this.#discardingFrame) {
      this.#discardingFrame = false;
      return;
    }

    const bytes = Buffer.concat(this.#frameChunks, this.#frameBytes);
    this.#resetFrame();
    let event: DecodedPerformerTurnEvent;
    try {
      const value = JSON.parse(this.#textDecoder.decode(bytes)) as JsonValue;
      event = decodeConductorPerformerPerformerTurnEvent(
        value,
      ) as unknown as DecodedPerformerTurnEvent;
    } catch {
      this.#report("performer_event_contract_invalid", this.#frameIndex - 1);
      return;
    }

    if (
      event.turn_id !== this.options.turnId ||
      event.root_issue_id !== this.options.rootIssueId ||
      event.work_issue_id !== this.options.workIssueId ||
      event.sequence !== this.#expectedSequence
    ) {
      this.#report("performer_event_correlation_invalid", this.#frameIndex - 1);
      return;
    }
    this.#expectedSequence += 1;
    this.options.onEvent(event);
  }

  #stop(code: PerformerEventStreamViolationCode): void {
    this.#report(code);
    this.#stopped = true;
    this.#resetFrame();
  }

  #report(
    code: PerformerEventStreamViolationCode,
    frameIndex = this.#frameIndex,
  ): void {
    this.options.onViolation({
      code,
      turn_id: this.options.turnId,
      root_issue_id: this.options.rootIssueId,
      ...(this.options.workIssueId === undefined
        ? {}
        : { work_issue_id: this.options.workIssueId }),
      expected_sequence: this.#expectedSequence,
      frame_index: frameIndex,
    });
  }

  #resetFrame(): void {
    this.#frameChunks.length = 0;
    this.#frameBytes = 0;
  }
}
