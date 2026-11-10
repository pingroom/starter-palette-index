import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const byte = value => Number.isInteger(value) && value >= 0 && value <= 255 && !Object.is(value, -0);
const dimension = value => Number.isInteger(value) && value >= 1 && value <= 256;
export const POLICY = Object.freeze({ distance: 'sum-of-squared-encoded-rgb-byte-differences-v1', tie: 'lowest-original-palette-entry-index-v1', pixelOrder: 'row-major-left-to-right-top-to-bottom-v1', alpha: 'unsupported', dithering: false });
export const POLICY_HASH = hash(POLICY);
function rgb(value) {
  if (!Array.isArray(value) || value.length !== 3 || !Array.from(value).every(byte)) throw new Error('Every RGB value must contain exactly three integer channels from 0 through 255.');
  return [...value];
}
const promptFor = input => `${input.title}\nAsset ${input.assetId}: ${input.width}x${input.height}, ${input.pixels.length} RGB pixels.\nUse: ${input.usage}\n${input.palettes.map(p => `${p.id}: ${p.label}; ${p.purpose}; ${p.colors.length} colors`).join('\n')}\nChoose the required palette, or Unknown. Pixels stay local.`;
export function validateInput(input) {
  if (!keys(input, ['assetId', 'title', 'usage', 'width', 'height', 'pixels', 'palettes']) || !word(input.assetId)
    || !line(input.title, 40) || !line(input.usage, 60) || !dimension(input.width) || !dimension(input.height) || input.width * input.height > 256
    || !Array.isArray(input.pixels) || input.pixels.length !== input.width * input.height
    || !Array.isArray(input.palettes) || input.palettes.length < 2 || input.palettes.length > 3) throw new Error('Supply an asset ID, title, use, dimensions for 1–256 pixels, RGB pixels, and two or three palettes.');
  const ids = new Set(), labels = new Set();
  const palettes = Array.from(input.palettes, p => {
    if (!keys(p, ['id', 'label', 'purpose', 'colors']) || !safeId(p.id) || ids.has(p.id) || !line(p.label, 20)
      || labels.has(p.label.toLowerCase()) || p.label.toLowerCase() === 'unknown' || !line(p.purpose, 24)
      || !Array.isArray(p.colors) || p.colors.length < 1 || p.colors.length > 16) throw new Error('Palettes require unique IDs and labels, a purpose, and one to sixteen ordered RGB colors.');
    ids.add(p.id); labels.add(p.label.toLowerCase());
    return { id: p.id, label: p.label, purpose: p.purpose, colors: Array.from(p.colors, rgb) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const result = { assetId: input.assetId, title: input.title, usage: input.usage, width: input.width, height: input.height, pixels: Array.from(input.pixels, rgb), palettes };
  if (promptFor(result).length > 500) throw new Error('Palette selection prompt exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact operator UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => [{ id: validateInput(input).assetId }];
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== input.assetId || !isId(attemptId)) throw new Error('Invalid asset or attempt.');
  const key = `palette-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.palettes.map(p => ({ value: p.id, label: p.label, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), policy_hash: POLICY_HASH, item_id: input.assetId, attempt_id: attemptId }, idempotencyKey: key };
}

/** Pure local conversion. Evidence-gated export is in engine.js. */
export function indexPixels(rawInput, paletteId) {
  const input = validateInput(rawInput), palette = input.palettes.find(p => p.id === paletteId);
  if (!palette) throw new Error('Select one declared palette ID.');
  const counts = Array(palette.colors.length).fill(0), channelSums = [0, 0, 0], indices = [], squaredErrors = [];
  let exactPixelCount = 0, maximumSquaredError = 0;
  for (const pixel of input.pixels) {
    let chosen = 0, best = Infinity;
    for (let index = 0; index < palette.colors.length; index++) {
      const error = pixel.reduce((sum, channel, axis) => sum + (channel - palette.colors[index][axis]) ** 2, 0);
      if (error < best) { best = error; chosen = index; }
    }
    indices.push(chosen); squaredErrors.push(best); counts[chosen]++;
    pixel.forEach((channel, axis) => { channelSums[axis] += (channel - palette.colors[chosen][axis]) ** 2; });
    if (best === 0) exactPixelCount++;
    maximumSquaredError = Math.max(maximumSquaredError, best);
  }
  const sumSquaredError = channelSums.reduce((sum, value) => sum + value, 0), n = input.pixels.length;
  return { version: 1, sourceHash: hash(input), policyHash: POLICY_HASH, width: input.width, height: input.height,
    palette: structuredClone(palette), indices, squaredErrors, entryCounts: counts,
    metrics: { pixelCount: n, exactPixelCount, changedPixelCount: n - exactPixelCount, channelSquaredErrorSums: channelSums, sumSquaredError, maximumSquaredError,
      meanSquaredErrorPerPixel: { numerator: sumSquaredError, denominator: n }, meanSquaredErrorPerChannel: { numerator: sumSquaredError, denominator: 3 * n } } };
}
export function assessSelection(rawInput, choice) {
  const input = validateInput(rawInput);
  if (choice !== null && choice !== 'unknown' && !input.palettes.some(p => p.id === choice)) throw new Error('Invalid palette selection.');
  const status = choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete';
  return { status, selectedPaletteId: status === 'complete' ? choice : null, conversion: status === 'complete' ? indexPixels(input, choice) : null };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed palette conversion. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved palette selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}



export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const evidence = { assetId: input.assetId, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  const calculation = assessSelection(input, evidence.choice);
  const status = ['create_unknown', 'pending'].includes(evidence.status) ? evidence.status : evidence.status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, assetId: input.assetId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers: [evidence], ...calculation, status,
    imageFilesInspected: false, pixelsSent: false, actionsExecuted: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved palette selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered palette selections must not contain palette selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
