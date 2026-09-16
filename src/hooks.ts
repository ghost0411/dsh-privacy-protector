import type { Context } from '@deepseek-ai/cordis'
// Real DSH types and event declarations, instead of hand-written ones.
//
// This header used to `declare module '@deepseek-ai/cordis'` with locally
// invented payload shapes. That is how a wrong field name survived: the code
// read `exec.args` (the real field is `exec.arguments`) and the unit tests
// hand-wrote a mock with the SAME wrong name, so both agreed and the feature
// was silently dead. `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-llm` and
// `@deepseek-ai/dsh-tools` ship the authoritative declarations as
// devDependencies, so importing them turns a renamed upstream field into a
// build failure, not a silent no-op. These are type-only imports: nothing new
// is required at runtime.
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message, StreamChunk, TextBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Rule } from './rules.js'
import type { Vault } from './vault.js'
import type { Guardian } from './guardian.js'
import { anonymize, restoreText, restoreJsonText, countRestorableTokens, PARTIAL_TOKEN_RE } from './sanitizer.js'
import { scanTopics, hasInducement } from './topics.js'

// Node environment: console is not in ES2022 lib.
declare const console: { log: (...args: unknown[]) => void }

export interface HookLog {
  (message: string): Promise<void> | void
}

export type SessionGate = (sessionId: string | undefined) => boolean

/** The live session behind a payload, when the caller supplied one. */
interface SessionLike {
  id?: string
  deriveMessages?: () => Message[]
}

/** Best-effort session lookup: payloads are untrusted at runtime, typed upstream. */
function sessionOf(payload: { agent?: Agent | unknown }): SessionLike | undefined {
  const agent = (payload as { agent?: { session?: unknown } }).agent
  const session = agent?.session as SessionLike | undefined
  return session !== null && typeof session === 'object' ? session : undefined
}

/** Extract a session id from any `{ agent: { session } }`-bearing payload. */
function sessionIdOf(payload: { agent?: Agent | unknown }): string | undefined {
  return sessionOf(payload)?.id
}

/**
 * The session's derived conversation history, or `[]` when unavailable.
 *
 * `payload.messages` on `agent/pre-step` is ONLY the user batch claimed for the
 * current turn (the agent loop's `inbox.claim()`), so it can never contain an
 * assistant message. Anything that needs the assistant side has to read the
 * session log — see {@link latestRoleTexts}.
 */
function historyOf(payload: { agent?: Agent | unknown }): Message[] {
  const session = sessionOf(payload)
  if (typeof session?.deriveMessages !== 'function') return []
  try {
    const messages = session.deriveMessages()
    return Array.isArray(messages) ? messages : []
  } catch {
    // A session log that cannot be projected must not break the turn.
    return []
  }
}

/** Concatenated plain text of a message's text blocks. */
function textOf(message: { content?: unknown }): string {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n')
}

/** The most recent assistant utterance and the most recent user utterance. */
function latestRoleTexts(messages: readonly { role?: unknown; content?: unknown }[]): { assistant: string; user: string } {
  let assistant = ''
  let user = ''
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'assistant') assistant = textOf(message)
    else if (message.role === 'user') user = textOf(message)
  }
  return { assistant, user }
}

/**
 * An acted-on inducement: the assistant fished for a sensitive disclosure
 * ("你月薪多少？") and the user then disclosed one ("我一个月挣 8k"). Only when
 * BOTH hold does the session get locked — a stray leading question with no
 * follow-up disclosure is not an inducement, and an unprompted disclosure is not
 * an act of social engineering.
 */
function isActedInducement(assistantText: string, userText: string): boolean {
  if (!assistantText || !userText) return false
  if (!hasInducement(assistantText)) return false
  return scanTopics(userText).hit
}

export function registerHooks(
  ctx: Context,
  vault: Vault,
  rules: Rule[],
  isEnabled: SessionGate,
  log: HookLog,
  guardian?: Guardian,
  onFirstUse?: () => void,
): void {
  // One-shot safety check, run the first time this session is about to talk to
  // the model — the moment a session-log export would actually matter.
  let firstUseReported = false
  const reportFirstUse = () => {
    if (firstUseReported) return
    firstUseReported = true
    try {
      onFirstUse?.()
    } catch {
      // a diagnostic must never break the turn
    }
  }
  // 1. Sanitize what the model sees: rewrite text content blocks in the
  //    derived messages. Always calls next() (waterfall discipline).
  //    Gated per-session: OFF sessions pass straight through untouched.
  //    When a guardian is armed, free-text sensitive disclosures are ALSO
  //    masked (semantic layer) and their categories are counted per session.
  ctx.on('agent/pre-step', async (payload, next) => {
    reportFirstUse()
    const sessionId = sessionIdOf(payload)
    const decision = await next()
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

    const batch = decision.messages
    let inducedFresh = false
    if (guardian) {
      // Regression: this used to scan `decision.messages` for an assistant
      // message. That array is only the claimed USER batch, so the lookup could
      // never succeed and the inducement lock was unreachable in production
      // while its tests passed on a mock that supplied both roles. The
      // assistant side comes from the session's derived history.
      const { assistant, user } = latestRoleTexts([...historyOf(payload), ...batch])
      inducedFresh = isActedInducement(assistant, user)
      if (inducedFresh) {
        guardian.markInduced(sessionId)
        await log('guardian locked session: assistant fished for a sensitive disclosure and user disclosed one')
      }
    }
    // An induced session stays protected even after the user toggles the guard off.
    const protect = guardian ? guardian.shouldProtect(sessionId) : false

    let masked = 0
    let guardianMasked = 0
    const scrubbed = batch.map((message) => {
      const content = message.content
      if (!Array.isArray(content)) return message
      let messageChanged = false
      const nextContent: ContentBlock[] = content.map((block) => {
        if (block.type !== 'text') return block
        let text = (block as TextBlock).text
        if (isEnabled(sessionId)) {
          const r = anonymize(text, vault, rules)
          masked += r.count
          if (r.count > 0) text = r.text
        }
        if (protect) {
          const scan = scanTopics(text)
          if (scan.hit) {
            for (const category of scan.categories) guardian!.count(sessionId, category)
            guardianMasked += 1
            text = scan.masked
          }
        }
        if (text === (block as TextBlock).text) return block
        messageChanged = true
        return { ...block, text }
      })
      return messageChanged ? { ...message, content: nextContent } : message
    })

    if (masked > 0) {
      await log(`masked ${masked} sensitive value(s) before model call`)
      return { ...decision, messages: scrubbed }
    }
    if (guardianMasked > 0) {
      await log(`guardian masked ${guardianMasked} sensitive disclosure(s) (semantic)`)
      return { ...decision, messages: scrubbed }
    }
    return decision
  })

  // 2. Restore tokens in the assistant stream so the user sees original values,
  //    AND restore tokens inside streamed tool-call arguments so a LOCAL tool
  //    runs on the original values instead of `[PII:...]` placeholders.
  ctx.on('llm/stream', async function* (options, next) {
    const upstream = await next()
    if (!isEnabled(options.sessionId)) {
      yield* upstream
      return
    }
    yield* restoreStream(upstream, vault)
  })

  // 3. Read-only backstop: observe the arguments a local tool is about to run
  //    with, and warn when a placeholder survived restoration.
  //
  //    This hook deliberately does NOT rewrite the arguments. `tools/pre-execute`
  //    receives `exec.arguments` deep-frozen by the tool registry, and rewriting
  //    it is unsupported BY DESIGN: `PreToolDecision` is `allow | deny | ask`
  //    only, and upstream documents that "input rewriting is excluded because
  //    arguments are already logged and presented". (An earlier revision
  //    mutated a non-existent `args` field, so tool-argument restoration
  //    silently never happened; a hand-written mock of the same shape kept the
  //    suite green.)
  //
  //    The supported place is upstream in hook 2, on the streamed
  //    `tool-call-delta` argument fragments, before the block is assembled and
  //    frozen. This hook only reports a restoration miss.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next) => {
    if (isEnabled(sessionIdOf(exec))) {
      const leaked = countRestorableTokens(exec.arguments, vault)
      if (leaked > 0) {
        await log(
          `warning: ${leaked} placeholder(s) reached tool "${String(exec.name ?? '?')}" un-restored; ` +
            'the tool ran on a [PII:...] token instead of the real value',
        )
      }
    }
    return next()
  })
}

/**
 * Hold back a trailing fragment only while it can still become a token.
 *
 * Returns `[head, tail]`: `head` is safe to emit now, `tail` must wait for more
 * input. A bare `[` is NOT buffered unless it is a plausible token prefix — see
 * {@link PARTIAL_TOKEN_RE} for why swallowing it corrupts prose and JSON.
 */
function splitPartialToken(text: string): [string, string] {
  const open = text.lastIndexOf('[')
  if (open < 0) return [text, '']
  const suffix = text.slice(open)
  if (!PARTIAL_TOKEN_RE.test(suffix)) return [text, '']
  return [text.slice(0, open), suffix]
}

type ToolCallDeltaChunk = Extract<StreamChunk, { type: 'tool-call-delta' }>

/** A held-back partial token, plus what is needed to re-emit it faithfully. */
interface HeldTail {
  kind: 'text' | 'reasoning' | 'tool'
  index: number
  text: string
  /** Tool-call deltas must repeat their id/name to stay in the same block run. */
  id?: ToolCallDeltaChunk['id']
  name?: string
}

function appendFragment(
  tails: Map<string, HeldTail>,
  kind: HeldTail['kind'],
  index: number,
  text: string,
  vault: Vault,
  identity?: { id: ToolCallDeltaChunk['id']; name?: string },
): string {
  const key = `${kind}:${index}`
  const combined = (tails.get(key)?.text ?? '') + text
  const [head, tail] = splitPartialToken(combined)
  if (tail) tails.set(key, { kind, index, text: tail, ...identity })
  else tails.delete(key)
  return kind === 'tool' ? restoreJsonText(head, vault) : restoreText(head, vault)
}

/**
 * Wrap a StreamChunk iterable, restoring `[PII:...]` tokens in:
 *
 *  - `text-delta` / `reasoning-delta` content and assembled text blocks, so the
 *    user reads original values; and
 *  - streamed `tool-call-delta.argumentsDelta` fragments and assembled tool-call
 *    blocks, so a LOCAL tool runs on original values.
 *
 * Why tool-call arguments are restored HERE and not on `tools/pre-execute`:
 * by the time that event fires the registry has already deep-frozen
 * `exec.arguments`, and rewriting it is excluded from `PreToolDecision` by
 * design. The streamed deltas are the last writable point before assembly —
 * `BlockAssembler` concatenates them into the frozen block the loop executes.
 *
 * Token text can be split across chunk boundaries, so a bare per-chunk restore
 * loses tokens (verified by test). A trailing fragment is held back ONLY while
 * it can still become a token, and is drained before the terminal `finish`
 * chunk so no input is ever swallowed.
 */
async function* restoreStream(
  upstream: AsyncIterable<StreamChunk>,
  vault: Vault,
): AsyncIterable<StreamChunk> {
  const tails = new Map<string, HeldTail>()

  function* drainTails(): Generator<StreamChunk> {
    for (const [key, tail] of [...tails]) {
      tails.delete(key)
      if (tail.kind === 'tool') {
        if (tail.id === undefined) continue
        yield {
          type: 'tool-call-delta',
          index: tail.index,
          id: tail.id,
          ...(tail.name === undefined ? {} : { name: tail.name }),
          argumentsDelta: tail.text,
        }
      } else {
        yield {
          type: tail.kind === 'text' ? 'text-delta' : 'reasoning-delta',
          index: tail.index,
          text: tail.text,
        }
      }
    }
  }

  for await (const chunk of upstream) {
    switch (chunk.type) {
      case 'finish':
        yield* drainTails()
        yield chunk
        break
      case 'text-delta':
        yield { ...chunk, text: appendFragment(tails, 'text', chunk.index, chunk.text, vault) }
        break
      case 'reasoning-delta':
        yield { ...chunk, text: appendFragment(tails, 'reasoning', chunk.index, chunk.text, vault) }
        break
      case 'tool-call-delta':
        yield {
          ...chunk,
          argumentsDelta: appendFragment(tails, 'tool', chunk.index, chunk.argumentsDelta, vault, {
            id: chunk.id,
            ...(chunk.name === undefined ? {} : { name: chunk.name }),
          }),
        }
        break
      case 'block-end': {
        const block = chunk.block
        if (block.type === 'text') {
          // Full serialized text; the flowing delta-tail buffer is no longer needed.
          tails.delete(`text:${chunk.index}`)
          yield { ...chunk, block: { ...block, text: restoreText(block.text, vault) } }
        } else if (block.type === 'tool-call') {
          // A closing block WINS over the accumulated deltas in BlockAssembler
          // ("first close wins"), so it must be restored too or it would clobber
          // the restored deltas with the raw placeholder text.
          tails.delete(`tool:${chunk.index}`)
          yield { ...chunk, block: { ...block, arguments: restoreJsonText(block.arguments, vault) } }
        } else {
          yield chunk
        }
        break
      }
      default:
        yield chunk
    }
  }
  yield* drainTails()
}
