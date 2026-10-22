/**
 * test/live-updates.test.mjs → live SSE subscribe + live encoder
 *
 * Graph/DAW hear a pulse only when 13-live-updates.js calls playPulse.
 * thinking is on that list. unknown / silent / tool_result stay wire-only.
 * The live encoder (14-pulse-audio.js) must name a Playable Instrument for
 * thinking so startVoice does not harp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LIVE_COGNITION_EVENTS, LIVE_PLAYPULSE_EVENTS } from '../experience/client-core.mjs';

const liveSrc = fs.readFileSync(new URL('../experience/client/13-live-updates.js', import.meta.url), 'utf8');
const audioSrc = fs.readFileSync(new URL('../experience/client/14-pulse-audio.js', import.meta.url), 'utf8');
const captureSrc = fs.readFileSync(new URL('../scripts/capture-live-feed.mjs', import.meta.url), 'utf8');

test('13-live-updates — cognition loop iterates LIVE_COGNITION_EVENTS', () => {
  assert.match(liveSrc, /for \(const cogEvent of LIVE_COGNITION_EVENTS\)/);
});

test('LIVE_COGNITION_EVENTS — matches the live cognition subscribe contract', () => {
  assert.deepEqual(LIVE_COGNITION_EVENTS, [
    'turn_complete', 'input_required',
    'human_turn', 'compact', 'permission', 'mode_shift',
    'tool_error', 'api_error', 'chirp', 'attachment', 'scaffold',
    'thinking',
  ]);
});

test('LIVE_PLAYPULSE_EVENTS — thinking in, unknown/silent/tool_result out', () => {
  assert.ok(LIVE_PLAYPULSE_EVENTS.includes('thinking'));
  for (const skip of ['unknown', 'silent', 'tool_result']) {
    assert.ok(!LIVE_PLAYPULSE_EVENTS.includes(skip), skip + ' stays wire-only');
  }
});

test('14-pulse-audio — thinking has a playable COG_SOUND (bell)', () => {
  assert.match(audioSrc, /thinking:\s*\{\s*instrument:\s*'bell'/);
  assert.match(audioSrc, /thinking:\s*'bell'/);
  assert.match(audioSrc, /tools:\s*\[[^\]]*'thinking'/);
});

test('capture-live-feed — playPulse set is LIVE_PLAYPULSE_EVENTS', () => {
  assert.match(captureSrc, /LIVE_PLAYPULSE_EVENTS/);
});
