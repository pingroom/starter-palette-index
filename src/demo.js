import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportIndexed } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/asset.json', import.meta.url), 65536);
for (const choice of ['mono', 'rgb', 'unknown']) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-palette-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    const pending = await step(options); assert.equal(pending.status, 'pending');
    api.answer(pending.answers[0].questionId, choice);
    const done = await step(options);
    assert.equal(done.status, choice === 'unknown' ? 'unknown' : 'complete');
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    if (choice === 'unknown') {
      assert.equal(done.conversion, null); await assert.rejects(exportIndexed(directory, input));
    } else {
      const exported = await exportIndexed(directory, input);
      assert.deepEqual((await readJson(exported.path)).conversion, done.conversion);
      assert.deepEqual(done.conversion.indices, choice === 'mono' ? [0, 1, 1, 0, 0, 0] : [0, 1, 1, 2, 3, 4]);
    }
    console.log(JSON.stringify({ scenario: choice, status: done.status, indices: done.conversion?.indices ?? null,
      sumSquaredError: done.conversion?.metrics.sumSquaredError ?? null, transport: 'real SDK with in-memory mock; no network' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
