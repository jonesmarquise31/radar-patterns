# 04 · Background generation

Run a slow model call behind a fast request.

A model call takes tens of seconds. A synchronous handler has about ten.
Blocking gives the user a spinner that ends in a gateway timeout, and the work
is lost.

**The split.** The foreground validates, computes everything deterministic,
persists the row, dispatches the job, and returns. The background loads the row,
builds the prompt, calls the model, parses, and patches. Deterministic output
never waits on generated output.

**Dispatch failure is not fatal.** The deterministic result is already persisted
and is what the caller is waiting on. A failed dispatch is logged and the row is
re-fireable by id.

**Model output is untrusted input.** It is asked for JSON and sometimes returns
JSON wrapped in prose or a fenced block. Parsing strips the fence, takes the
outermost balanced object, and classifies its failures — `empty_response`,
`no_json_object`, `invalid_json` — because "it didn't work" is not actionable at
3am.

**Nothing stays pending.** Every failure branch patches the row to a terminal
state and alerts. A row stuck in `pending_generation` is a support ticket nobody
knows about yet.

The prompt itself is deliberately not in this repository.

Run: `node --test background-generation.test.js`
