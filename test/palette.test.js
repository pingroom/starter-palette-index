import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportIndexed } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, assessSelection, indexPixels, POLICY_HASH, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/asset.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-palette-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later selections; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'mono'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'complete');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a selection', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'mono'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'mono'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.conversion, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and original creation intent', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).conversion, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'mono');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'mono'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'mono'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing reviewer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'mono');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'mono'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).conversion, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});

// Independent reference ranks colors by ||c||² - 2p·c; the omitted ||p||² is common.
function oracle(input, paletteId) {
  const palette = input.palettes.find(p => p.id === paletteId), counts = Array(palette.colors.length).fill(0);
  const squaredErrors = [], channelSums = [0n, 0n, 0n];
  const indices = input.pixels.map(pixel => {
    const ranked = palette.colors.map((color, index) => ({ index, score: color.reduce((sum, c, axis) => sum + BigInt(c) * BigInt(c) - 2n * BigInt(pixel[axis]) * BigInt(c), 0n) }));
    ranked.sort((a, b) => a.score < b.score ? -1 : a.score > b.score ? 1 : a.index - b.index);
    const index = ranked[0].index; counts[index]++;
    const errors = pixel.map((p, axis) => { const d = BigInt(p) - BigInt(palette.colors[index][axis]); return d * d; });
    errors.forEach((e, axis) => { channelSums[axis] += e; }); squaredErrors.push(Number(errors.reduce((s, e) => s + e, 0n)));
    return index;
  });
  return { indices, squaredErrors, counts, channelSums: channelSums.map(Number), sum: Number(channelSums.reduce((a, b) => a + b, 0n)) };
}
function checkOracle(input, paletteId) {
  const expected = oracle(input, paletteId), output = indexPixels(input, paletteId);
  assert.deepEqual(output.indices, expected.indices); assert.deepEqual(output.squaredErrors, expected.squaredErrors);
  assert.deepEqual(output.entryCounts, expected.counts); assert.deepEqual(output.metrics.channelSquaredErrorSums, expected.channelSums);
  assert.equal(output.metrics.sumSquaredError, expected.sum);
  assert.equal(output.metrics.exactPixelCount, expected.squaredErrors.filter(x => x === 0).length);
  assert.equal(output.metrics.changedPixelCount + output.metrics.exactPixelCount, input.pixels.length);
  assert.equal(output.entryCounts.reduce((a, b) => a + b), input.pixels.length);
  assert.equal(output.metrics.maximumSquaredError, Math.max(...expected.squaredErrors));
  assert.deepEqual(output.metrics.meanSquaredErrorPerPixel, { numerator: expected.sum, denominator: input.pixels.length });
  assert.deepEqual(output.metrics.meanSquaredErrorPerChannel, { numerator: expected.sum, denominator: 3 * input.pixels.length });
  return output;
}

test('65,536 varied RGB pixels match an independent BigInt ranking/error oracle across all palette sizes', () => {
  let seed = 0x7a5c1234;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const color = () => { const n = next(); return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]; };
  for (let iteration = 0; iteration < 256; iteration++) {
    const input = simple(); input.width = 16; input.height = 16;
    input.pixels = Array.from({ length: 256 }, color); input.palettes[0].colors = Array.from({ length: iteration % 16 + 1 }, color);
    checkOracle(input, 'mono');
  }
});

test('exact colors, duplicate entries and equidistant colors select the lowest original palette index', () => {
  const input = simple(); input.width = 3; input.height = 1;
  input.pixels = [[1, 0, 0], [0, 0, 0], [2, 0, 0]];
  input.palettes[0].colors = [[2, 0, 0], [0, 0, 0], [2, 0, 0]];
  const result = checkOracle(input, 'mono'); assert.deepEqual(result.indices, [0, 1, 0]); assert.deepEqual(result.entryCounts, [2, 1, 0]);
  assert.deepEqual(result.squaredErrors, [1, 0, 0]);
  input.palettes[0].colors.reverse(); assert.deepEqual(checkOracle(input, 'mono').indices, [0, 1, 0]);
  input.palettes[0].colors = [[0, 0, 0], [2, 0, 0]]; assert.deepEqual(checkOracle(input, 'mono').indices, [0, 0, 1]);
});

test('all grayscale values and maximum error preserve exact integer sums and unreduced rational metrics', () => {
  const input = simple(); input.width = 256; input.height = 1; input.pixels = Array.from({ length: 256 }, (_, i) => [i, i, i]);
  checkOracle(input, 'mono'); input.pixels = Array.from({ length: 256 }, () => [255, 255, 255]); input.palettes[0].colors = [[0, 0, 0]];
  const result = checkOracle(input, 'mono'); assert.equal(result.metrics.maximumSquaredError, 195075); assert.equal(result.metrics.sumSquaredError, 49939200);
  assert.deepEqual(result.metrics.meanSquaredErrorPerChannel, { numerator: 49939200, denominator: 768 });
  input.width = 1; input.pixels = [[0, 0, 0]]; assert.deepEqual(checkOracle(input, 'mono').indices, [0]);
});

test('each choice maps row-major positions locally; Unknown and missing selections withhold every conversion', () => {
  const input = simple(); assert.deepEqual(assessSelection(input, 'rgb').conversion.indices, [0, 1, 1, 2, 3, 4]);
  assert.deepEqual(assessSelection(input, 'mono').conversion.indices, [0, 1, 1, 0, 0, 0]);
  for (const choice of [null, 'unknown']) { const result = assessSelection(input, choice); assert.equal(result.conversion, null); assert.equal(result.selectedPaletteId, null); }
  for (const choice of ['Unknown', 'missing', undefined, 0]) assert.throws(() => assessSelection(input, choice));
  assert.throws(() => indexPixels(input, 'unknown'));
});

test('palette-set ordering canonicalizes but pixel/channel/entry order and metadata remain bound', async t => {
  const s = await setup(t); await decide(s, ['mono']); const canonical = validateInput(simple());
  const permuted = simple(); permuted.palettes.reverse(); assert.equal(hash(validateInput(permuted)), hash(canonical));
  assert.deepEqual(await localReport(s.directory, permuted), await localReport(s.directory, simple()));
  for (const mutate of [x => x.pixels.reverse(), x => x.pixels[3].reverse(), x => x.palettes[0].colors.reverse(), x => { x.usage = 'Different target'; }, x => { x.width = 2; x.height = 3; }]) {
    const changed = simple(); mutate(changed); assert.notEqual(hash(validateInput(changed)), hash(canonical));
    const before = s.api.calls.length; await assert.rejects(s.run({ input: changed })); assert.equal(s.api.calls.length, before);
  }
});

test('exact schemas reject wrong dimensions, alpha, non-bytes, sparse arrays and merged-key attacks before API', async t => {
  for (const mutate of [
    x => { x.width = 0; }, x => { x.height = 257; }, x => { x.width = 1.5; }, x => { x.width = 256; x.height = 2; },
    x => { x.pixels.pop(); }, x => { delete x.pixels[0]; }, x => { x.pixels[0].push(255); }, x => { delete x.pixels[0][1]; },
    x => { x.pixels[0][0] = -0; }, x => { x.pixels[0][0] = '0'; }, x => { x.pixels[0][0] = -1; }, x => { x.pixels[0][0] = 256; },
    x => { x.pixels[0][0] = Infinity; }, x => { x.pixels[0][0] = 0.1; }, x => { x.palettes = []; }, x => { x.palettes.length = 1; },
    x => { delete x.palettes[0]; }, x => { x.palettes[0].colors = []; }, x => { x.palettes[0].colors = Array(17).fill([0, 0, 0]); },
    x => { x.palettes[0].colors = Array(2); }, x => { x.palettes[0].colors[0][0] = -1; }, x => { x.palettes[1].id = x.palettes[0].id; },
    x => { x.palettes[0].id = 'unknown'; }, x => { x.palettes[0].id = 'constructor'; }, x => { x.palettes[0].label = 'Unknown'; },
    x => { x.palettes[1].label = x.palettes[0].label.toUpperCase(); }, x => { x.alpha = true; },
    x => { x['height,width'] = 3; delete x.height; delete x.width; }, x => { x.palettes[0]['label,purpose'] = 'merged'; delete x.palettes[0].label; delete x.palettes[0].purpose; },
  ]) { const input = simple(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); }
});

test('metadata, Unicode and true-end identities stay bounded before network', async t => {
  for (const mutate of [
    x => { x.assetId += '\n'; }, x => { x.assetId = 'a'.repeat(41); }, x => { x.palettes[0].id += '\n'; },
    x => { x.palettes[0].id = 'a'.repeat(17); }, x => { x.title = 'a'.repeat(41); }, x => { x.usage = 'a'.repeat(61); },
    x => { x.palettes[0].label = 'a'.repeat(21); }, x => { x.palettes[0].purpose = 'a'.repeat(25); },
    x => { x.title = 'Bad\ud800'; }, x => { x.usage = 'Bad\u202etext'; }, x => { x.title = ' space'; }, x => { x.usage = 'line\nend'; },
  ]) { const input = simple(); mutate(input); const s = await setup(t, input); await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0); }
  assert.equal(isId(id(1) + '\n'), false); assert.equal(ROOM.test(ROOM_CODE + '\n'), false);
  for (const connection of [{ token: 'x\n', room: ROOM_CODE }, { token: 'x', room: ROOM_CODE + '\n' }]) assert.throws(() => validateConnection(connection));
  const config = structuredClone(CONFIG); config.participant.id += '\n'; assert.throws(() => requestFor(simple(), config, simple().assetId, id(1)));
  const s = await setup(t); await assert.rejects(s.run({ token: 'x\n' })); await assert.rejects(s.run({ room: ROOM_CODE + '\n' })); assert.equal(s.api.calls.length, 0);
});

test('maximum input yields one bounded metadata-only Question and never leaks RGB arrays to the API', async t => {
  const input = { ...simple(), assetId: 'a'.repeat(40), title: '🟦'.repeat(20), usage: '🟨'.repeat(30), width: 256, height: 1,
    pixels: Array.from({ length: 256 }, () => [17, 93, 211]), palettes: Array.from({ length: 3 }, (_, i) => ({ id: 'p'.repeat(15) + i, label: 'a'.repeat(19) + i,
      purpose: '🟪'.repeat(12), colors: Array.from({ length: 16 }, () => [83, 71, 29]) })) };
  const request = requestFor(input, CONFIG, input.assetId, id(1)); assert.equal(request.prompt.length, 465); assert.ok(request.context.length <= 40); assert.equal(request.options.length, 4);
  assert.equal(request.data.input_hash, hash(validateInput(input))); assert.equal(request.data.policy_hash, POLICY_HASH);
  assert.equal(JSON.stringify(request).includes('[17,93,211]'), false); assert.equal(JSON.stringify(request).includes('[83,71,29]'), false);
  for (const palette of input.palettes) for (const text of [palette.label, palette.purpose, palette.id]) assert.ok(request.prompt.includes(text));
  const s = await setup(t, input); const result = await decide(s, [input.palettes[0].id]); assert.equal(result.status, 'complete'); await s.run(); assert.equal(sends(s.api), 1);
  assert.equal(s.api.calls.filter(c => c.method === 'POST').some(c => 'pixels' in c.body || 'palettes' in c.body || 'colors' in c.body.data), false);
});

test('optional default flags accept absent/false but reject true, null, numeric and string values', async t => {
  const s = await setup(t); await s.run(); const q = s.api.questions.get(id(1));
  for (const option of q.options) { delete option.primary; delete option.destructive; }
  assert.equal((await s.run()).status, 'pending'); s.api.answer(id(1), 'rgb'); assert.equal((await s.run()).status, 'complete');
  for (const key of ['primary', 'destructive']) for (const value of [true, null, 0, 'false']) {
    const other = await setup(t); await other.run(); other.api.questions.get(id(1)).options[0][key] = value; await assert.rejects(other.run());
  }
});

test('complete SDK selection exports immutable source and exact indices with attributed evidence', async t => {
  const s = await setup(t), result = await decide(s, ['rgb']); const exported = await exportIndexed(s.directory, s.options.input), saved = await readJson(exported.path);
  assert.deepEqual(saved.conversion, result.conversion); assert.deepEqual(saved.source, validateInput(simple())); assert.equal(exported.selectedPaletteId, 'rgb');
  assert.equal(saved.answers[0].responderId, CONFIG.participant.id); assert.equal(saved.answers[0].askerId, ASKER); assert.ok(saved.answers[0].answeredAt);
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600); assert.equal(saved.pixelsSent, false);
  const before = s.api.calls.length; await localReport(s.directory, simple(), { save: true }); await exportIndexed(s.directory, simple()); assert.equal(s.api.calls.length, before);
});

test('missing, Unknown, cancelled, expired or invalid evidence cannot export and cannot trigger replacement', async t => {
  for (const outcome of ['missing', 'unknown', 'cancelled', 'expired', 'invalid']) {
    const s = await setup(t); await assert.rejects(exportIndexed(s.directory, s.options.input)); await s.run();
    if (outcome !== 'missing') {
      if (outcome === 'unknown') s.api.answer(id(1), 'unknown');
      else if (outcome === 'invalid') { s.api.answer(id(1), 'rgb'); s.api.questions.get(id(1)).answer.responder.id = OTHER; }
      else { if (outcome === 'expired') s.clock.value = '2026-01-01T09:16:00.000Z'; s.api.terminal(id(1), outcome); }
      await s.run();
    }
    assert.equal((await localReport(s.directory, s.options.input)).conversion, null); await assert.rejects(exportIndexed(s.directory, s.options.input));
    assert.equal(await readJson(join(s.directory, 'indexed.json')), null); await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('export lock and corrupted evidence preserve a previously valid artifact', async t => {
  const s = await setup(t); await decide(s, ['rgb']); const exported = await exportIndexed(s.directory, s.options.input), original = await readFile(exported.path, 'utf8');
  const release = await acquireLock(s.directory); await assert.rejects(exportIndexed(s.directory, s.options.input), /lock exists/); await release();
  const saved = await s.saved(); saved.attempts[0].observation.answer.label = 'Wrong label'; await atomicJson(s.directory, 'state.json', saved);
  await assert.rejects(exportIndexed(s.directory, s.options.input)); assert.equal(await readFile(exported.path, 'utf8'), original);
});
