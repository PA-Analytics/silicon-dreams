import assert from 'node:assert/strict';
import { grainFrameAt } from '../src/pipeline.ts';

// Camera motion changes render frequency, not the film exposure cadence.
for (const fps of [15, 30, 60, 120]) {
  const exposures = new Set(Array.from({ length: fps }, (_, frame) => grainFrameAt(frame * 1000 / fps)));
  assert.equal(exposures.size, 15, 'grain cadence at ' + fps + ' FPS');
}
assert.equal(grainFrameAt(0), grainFrameAt(16));
assert.equal(grainFrameAt(0), grainFrameAt(65));
assert.equal(grainFrameAt(67), 1);
assert.equal(grainFrameAt(1000), 15);
console.log('PASS: grain holds at 15 Hz at 15/30/60/120 FPS.');
