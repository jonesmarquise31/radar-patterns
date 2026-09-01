'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Deferred LLM generation behind a synchronous request.
// ─────────────────────────────────────────────────────────────────────────────
// A model call takes tens of seconds. A synchronous handler typically has ten.
// Blocking the request on generation gives the user a spinner that ends in a
// gateway timeout, and the work is lost.
//
// The split:
//   Foreground — validate, compute what is cheap and deterministic, persist the
//                row, dispatch the job, return immediately. The user gets their
//                deterministic result now.
//   Background — load the row, build the prompt, call the model, parse, patch
//                the row with the generated text.
//
// Deterministic output is never made to wait on generated output. If the model
// is down the user still gets scores; only the prose is missing, and the row
// can be re-fired by id.
//
// The prompt itself is intentionally not in this repository.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Foreground half. Returns as soon as the job is dispatched.
 *
 * Dispatch failure is logged, never fatal: the deterministic result is already
 * persisted and is the part the caller is waiting on.
 */
async function submitAndDispatch(input, deps) {
  const validation = deps.validate(input);
  if (!validation.ok) {
    return { statusCode: 400, body: { error: validation.error, code: 'SUBMIT-01' } };
  }

  const computed = deps.computeDeterministic(validation.value);
  const row = await deps.insertRow({ ...computed, status: 'pending_generation' });

  let dispatched = true;
  try {
    await deps.dispatchBackground({ row_id: row.id });
  } catch (err) {
    dispatched = false;
    deps.log('dispatch failed for row ' + row.id + '; re-fire manually', err);
  }

  return {
    statusCode: 200,
    body: { id: row.id, ...computed, generation: dispatched ? 'pending' : 'dispatch_failed' },
  };
}

/**
 * Models are asked for JSON and sometimes return it wrapped in prose or a
 * fenced block. Strip the fence, then take the outermost balanced object.
 * A parse failure is a normal branch, not an exception.
 */
function parseModelJson(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'empty_response' };
  }

  let candidate = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate);
  if (fenced) candidate = fenced[1].trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, reason: 'no_json_object' };
  }

  try {
    return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false, reason: 'invalid_json' };
  }
}

/**
 * Validate the model returned the shape that was asked for.
 * An LLM response is untrusted input like any other.
 */
function validateShape(value, requiredFields) {
  if (!value || typeof value !== 'object') return { ok: false, missing: requiredFields.slice() };
  const missing = requiredFields.filter((f) => value[f] == null || value[f] === '');
  return missing.length ? { ok: false, missing } : { ok: true, value };
}

/**
 * Background half. Marks terminal failures so a row never sits in
 * `pending_generation` forever with nothing watching it.
 */
async function runGeneration(rowId, deps, opts) {
  const required = (opts && opts.requiredFields) || ['narrative'];

  const row = await deps.loadRow(rowId);
  if (!row) return { ok: false, reason: 'row_not_found' };
  if (row.status === 'generated') return { ok: true, skipped: true, reason: 'already_generated' };

  const context = await deps.loadContext(row);

  let raw;
  try {
    raw = await deps.callModel({ row, context });
  } catch (err) {
    await deps.patchRow(rowId, { status: 'generation_failed', error: String(err.message || err) });
    await deps.alert('Generation failed for row ' + rowId + ': ' + (err.message || err));
    return { ok: false, reason: 'model_error' };
  }

  const parsed = parseModelJson(raw);
  if (!parsed.ok) {
    await deps.patchRow(rowId, { status: 'generation_failed', error: parsed.reason });
    await deps.alert('Unparseable model output for row ' + rowId + ' (' + parsed.reason + ')');
    return { ok: false, reason: parsed.reason };
  }

  const shape = validateShape(parsed.value, required);
  if (!shape.ok) {
    await deps.patchRow(rowId, { status: 'generation_failed', error: 'missing: ' + shape.missing.join(',') });
    await deps.alert('Model output missing fields for row ' + rowId + ': ' + shape.missing.join(', '));
    return { ok: false, reason: 'missing_fields', missing: shape.missing };
  }

  await deps.patchRow(rowId, { ...shape.value, status: 'generated' });
  return { ok: true, rowId: rowId };
}

module.exports = { submitAndDispatch, runGeneration, parseModelJson, validateShape };
