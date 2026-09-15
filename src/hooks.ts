import type { Context } from '@deepseek-ai/cordis'
import type { Rule } from './rules.js'
import type { Vault } from './vault.js'
import type { Guardian } from './guardian.js'
import { anonymize, restoreText } from './sanitizer.js'
import { scanTopics, hasInducement } from './topics.js'

// Declare the DSH events this plugin listens to so the type checker is happy.
// These are declaration-merged into the global Events interface at build time;
// exact payload shapes depend on the pinned upstream version.
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step': (payload: { agent?: unknown; messages: unknown[]; turn: number; step: number; signal?: unknown }, next: () => Promise<Record<string, unknown>>) => Promise<Record<string, unknown>>
    'llm/stream': (options: Record<string, unknown> & { sessionId?: string }, next: () => AsyncIterable<Record<string, unknown>>) => AsyncIterable<Record<string, unknown>>
    'tools/pre-execute': (execution: { agent?: unknown; name?: string; args?: unknown }, next: () => Promise<unknown>) => Promise<unknown>
  }
}

// Node environment: console is not in ES2022 lib.
declare const console: { log: (...args: unknown[]) => void }

export interface HookLog {
  (message: string): Promise<void> | void
}

export type SessionGate = (sessionId: string | undefined) => boolean

/** Extract a session id from any `{ agent..., session }`-bearing payload. */
function sessionIdOf(payload: { agent?: unknown }): string | undefined {
  const agent = payload?.agent as { session?: { id?: string } } | undefined
  return agent?.session?.id
}

/** Concatenated plain text of a message's text blocks. */
function textOf(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

/**
 * Detect an acted-on inducement: the latest assistant message fished for a
 * sensitive disclosure ("你月薪多少？") and the latest user message then
 * disclosed one ("我一个月挣 8k"). Only when BOTH hold does the session get
 * locked — a stray leading question with no follow-up disclosure is not an
 * inducement, and an unprompted disclosure is not an act of social engineering.
 */
function detectInducement(messages: Record<string, unknown>[]): boolean {
  let assistantText = ''
  let userText = ''
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'assistant') assistantText = textOf(message)
    else if (message.role === 'user') userText = textOf(message)
  }
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
): void {
  // 1. Sanitize what the model sees: rewrite text content blocks in the
  //    derived messages. Always calls next() (waterfall discipline).
  //    Gated per-session: OFF sessions pass straight through untouched.
  //    When a guardian is armed, free-text sensitive disclosures are ALSO
  //    masked (semantic layer) and their categories are counted per session.
  ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = sessionIdOf(payload)
    const decision = await next()
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision

    const messages = decision.messages as Record<string, unknown>[]
    let inducedFresh = false
    if (guardian) {
      inducedFresh = detectInducement(messages)
      if (inducedFresh) {
        guardian.markInduced(sessionId)
        await log(`guardian locked session: assistant fished for a sensitive disclosure and user disclosed one`)
      }
    }
    // An induced session stays protected even after the user toggles the guard off.
    const protect = guardian ? guardian.shouldProtect(sessionId) : false

    let masked = 0
    let guardianMasked = 0
    const scrubbed = messages.map((message: Record<string, unknown>) => {
      if (!message || typeof message !== 'object') return message
      const nextMessage = { ...message }
      let messageChanged = false
      const content = Array.isArray(nextMessage.content)
        ? nextMessage.content.map((block: Record<string, unknown>) => {
            if (block?.type === 'text' && typeof block.text === 'string') {
              let text = block.text
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
              if (text !== block.text) messageChanged = true
              return text !== block.text ? { ...block, text } : block
            }
            return block
          })
        : nextMessage.content
      return messageChanged ? { ...nextMessage, content } : nextMessage
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

  // 2. Restore tokens in the assistant stream so the user sees original values.
  ctx.on('llm/stream', async function* (options, next) {
    const upstream = await next()
    if (!isEnabled((options as { sessionId?: string }).sessionId)) {
      yield* upstream
      return
    }
    yield* restoreStream(upstream, vault)
  })

  // 3. Restore tokens in tool call arguments before a local tool executes.
  ctx.on('tools/pre-execute', async (execution, next) => {
    const sessionId = (execution as { agent?: { session?: { id?: string } } }).agent?.session?.id
    if (!isEnabled(sessionId)) return next()

    const args = (execution as { args?: unknown }).args
    const restored = restoreDeep(args, vault)
    if (restored !== undefined && args !== undefined && args !== null) {
      try {
        const target = args as Record<string, unknown>
        for (const key of Object.keys(target)) {
          ;(target as Record<string, unknown>)[key] = restoreDeep(target[key], vault)
        }
      } catch {
        // frozen/shared object: fall through
      }
    }
    return next()
  })
}

function restoreDeep(value: unknown, vault: Vault): unknown {
  if (typeof value === 'string') return restoreText(value, vault)
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const r = restoreDeep(item, vault)
      if (r !== item) changed = true
      return r
    })
    return changed ? out : value
  }
  if (value !== null && typeof value === 'object') {
    let changed = false
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const r = restoreDeep(item, vault)
      if (r !== item) changed = true
      out[key] = r
    }
    return changed ? out : value
  }
  return value
}

/**
 * Wrap a StreamChunk iterable, restoring `[PII:...]` tokens inside
 * text-delta / reasoning-delta content and in fully-assembled text blocks.
 *
 * Streaming deltas can split a token across chunk boundaries, so a bare
 * per-chunk `restoreText` loses tokens (verified by test). We hold the
 * open-bracket tail per index and restore the remainder immediately.
 */
async function* restoreStream(
  upstream: AsyncIterable<Record<string, unknown>>,
  vault: Vault,
): AsyncIterable<Record<string, unknown>> {
  const tails = new Map<string, string>()

  const restoreDelta = (kind: string, index: unknown, text: string): string => {
    const key = `${kind}:${index}`
    const combined = (tails.get(key) ?? '') + text
    const open = combined.lastIndexOf('[')
    let head: string
    let tail: string
    if (open >= 0 && !combined.slice(open).includes(']')) {
      head = combined.slice(0, open)
      tail = combined.slice(open)
    } else {
      head = combined
      tail = ''
    }
    if (tail) tails.set(key, tail)
    else tails.delete(key)
    return restoreText(head, vault)
  }

  for await (const chunk of upstream) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      yield { ...chunk, text: restoreDelta('text', chunk.index, chunk.text) }
    } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      yield { ...chunk, text: restoreDelta('reasoning', chunk.index, chunk.text) }
    } else if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
      const block = chunk.block as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string') {
        // Full serialized text; the flowing delta-tail buffer is no longer needed.
        tails.delete(`text:${chunk.index}`)
        yield { ...chunk, block: { ...block, text: restoreText(block.text, vault) } }
      } else {
        yield chunk
      }
    } else {
      yield chunk
    }
  }
}