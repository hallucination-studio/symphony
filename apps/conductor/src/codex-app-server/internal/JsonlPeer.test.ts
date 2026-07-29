import assert from "node:assert/strict";
import test from "node:test";

import { JsonlFrameDecoder, encodeJsonl } from "./JsonlPeer.js";

test("JSONL decoder handles split and coalesced frames deterministically", () => {
  const decoder = new JsonlFrameDecoder(128);
  assert.deepEqual(decoder.push(Buffer.from('{"id":1')), []);
  assert.deepEqual(decoder.push(Buffer.from('}\n{"id":2}\n')), [{ id: 1 }, { id: 2 }]);
  decoder.finish();
  assert.equal(encodeJsonl({ id: 3 }).toString("utf8"), '{"id":3}\n');
});

test("JSONL decoder rejects malformed, oversized, and truncated frames", () => {
  assert.throws(() => new JsonlFrameDecoder(4).push(Buffer.from("12345")), /jsonl_frame_too_large/u);
  assert.throws(() => new JsonlFrameDecoder().push(Buffer.from("not-json\n")), /malformed_jsonl_frame/u);
  const truncated = new JsonlFrameDecoder();
  truncated.push(Buffer.from('{"id":1}'));
  assert.throws(() => truncated.finish(), /truncated_jsonl_frame/u);
});
