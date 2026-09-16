/**
 * Compile-time contract with the installed DSH.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An earlier revision of `src/hooks.ts` read `exec.args` from the
 * `tools/pre-execute` event. The real field is `exec.arguments`, so
 * tool-argument restoration silently never ran — no error, no failing test. The
 * unit tests did not catch it because they hand-wrote a mock with the SAME wrong
 * field name: the mock encoded the same assumption as the code, so the suite
 * stayed green while the feature was dead. That mistake cost two debugging
 * rounds.
 *
 * The fix is to stop asking a hand-written mock what DSH sends, and ask DSH.
 * `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` ship their real
 * declarations as devDependencies, so the field names below are asserted
 * against upstream types at BUILD time. Rename a field upstream and
 * `npx tsc -p tsconfig.contract.json` fails, naming this file.
 *
 * It is checked by `npm run test:contract` (and by CI / `npm run build`).
 */

import type { ToolExecution, ToolExecutionInput, PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Assert a type-level boolean is `true`. */
type Expect<T extends true> = T
/** Exact type equality (invariant in both directions). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** Helper: is `K` a key of `T`? */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false

// ---------------------------------------------------------------------------
// tools/pre-execute — the payload our handler is handed
// ---------------------------------------------------------------------------

/** The plugin reads `exec.arguments`. */
type _ExecHasArguments = Expect<Equal<HasKey<ToolExecutionInput, 'arguments'>, true>>
/** ...and `exec.agent.session.id` for the per-session gate. */
type _ExecHasAgent = Expect<Equal<HasKey<ToolExecutionInput, 'agent'>, true>>
/** ...and `exec.name` for the warning message. */
type _ExecHasName = Expect<Equal<HasKey<ToolExecutionInput, 'name'>, true>>
/**
 * The historical bug, pinned: `args` must NOT be a field. If upstream ever adds
 * one, this line fails and forces a deliberate decision instead of a silent
 * misread.
 */
type _ExecHasNoArgsField = Expect<Equal<HasKey<ToolExecutionInput, 'args'>, false>>

/** The registry hands the handler the fully-built execution object. */
type _HandlerSeesToolExecution = Expect<Equal<ToolExecution extends ToolExecutionInput ? true : false, true>>

/**
 * `PreToolDecision` cannot express a rewrite. This is WHY the plugin does not try
 * to restore tokens here, and why restoration lives on `llm/stream` instead: the
 * decision type is `allow | deny | ask` only, and upstream documents that
 * "input rewriting is excluded because arguments are already logged and
 * presented". If a rewrite variant ever appears, this assertion fails and the
 * simpler hook becomes available again.
 */
type _DecisionIsAllowDenyAsk = Expect<Equal<PreToolDecision['kind'], 'allow' | 'deny' | 'ask'>>
type _DecisionHasNoArguments = Expect<Equal<Extract<PreToolDecision, { arguments: unknown }>, never>>
type _DecisionHasNoRewrite = Expect<Equal<Extract<PreToolDecision, { rewrite: unknown }>, never>>

// ---------------------------------------------------------------------------
// llm/stream — the chunk union our restorer rewrites
// ---------------------------------------------------------------------------

type ToolCallDelta = Extract<StreamChunk, { type: 'tool-call-delta' }>
type TextDelta = Extract<StreamChunk, { type: 'text-delta' }>
type ReasoningDelta = Extract<StreamChunk, { type: 'reasoning-delta' }>
type BlockEnd = Extract<StreamChunk, { type: 'block-end' }>

/** Tool arguments stream as `argumentsDelta`, NOT as a parsed object. */
type _DeltaHasArgumentsDelta = Expect<Equal<HasKey<ToolCallDelta, 'argumentsDelta'>, true>>
type _DeltaArgumentsDeltaIsString = Expect<Equal<ToolCallDelta['argumentsDelta'], string>>
/** Identity fields, needed to re-emit a held tail as a valid delta. */
type _DeltaHasIndex = Expect<Equal<ToolCallDelta['index'], number>>
type _DeltaHasId = Expect<Equal<HasKey<ToolCallDelta, 'id'>, true>>
type _DeltaHasOptionalName = Expect<Equal<HasKey<ToolCallDelta, 'name'>, true>>
/** Text/reasoning deltas carry `text`. */
type _TextDeltaIsString = Expect<Equal<TextDelta['text'], string>>
type _ReasoningDeltaIsString = Expect<Equal<ReasoningDelta['text'], string>>
/** A block-end carries the assembled block, which wins over the deltas. */
type _BlockEndHasBlock = Expect<Equal<HasKey<BlockEnd, 'block'>, true>>

/** The union still has the members our generator switches on. */
type _FinishIsInUnion = Expect<Equal<Extract<StreamChunk, { type: 'finish' }> extends never ? false : true, true>>

// ---------------------------------------------------------------------------
// Compile-time shape assertions about THIS plugin's declarations
// ---------------------------------------------------------------------------

import type { Events } from '@deepseek-ai/cordis'

type PreExecuteArgs = Parameters<Events['tools/pre-execute']>
type LlmStreamArgs = Parameters<Events['llm/stream']>

/**
 * Our declared `tools/pre-execute` payload must accept the real `ToolExecution`.
 * Assignability is checked in the direction that matters: a real DSH execution
 * must be passable to our handler.
 */
type _OurExecAcceptsRealExecution = Expect<
  Equal<ToolExecution extends PreExecuteArgs[0] ? true : false, true>
>

/**
 * Our declared `llm/stream` options must carry a usable `sessionId` — the
 * per-session gate reads it. (Asserted as a key rather than assignability to
 * `Record<string, unknown>`, because an `interface` does not get an implicit
 * index signature.)
 */
type _StreamOptionsHaveSessionId = Expect<Equal<HasKey<LlmStreamArgs[0], 'sessionId'>, true>>
/** And the chunk type our restorer rewrites is the real union. */
type _StreamChunksAreRealChunks = Expect<Equal<Awaited<ReturnType<LlmStreamArgs[1]>> extends AsyncIterable<StreamChunk> ? true : false, true>>

// Keep TypeScript from eliding the file as "no value exports".
export const checked = true
