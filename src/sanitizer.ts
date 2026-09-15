import type { Rule } from './rules.js'
import type { Vault } from './vault.js'

export const TOKEN_RE = /\[PII:([A-Z_]+):(\d+)\]/g

export interface AnonymizeResult {
  text: string
  count: number
}

export interface PiiHit {
  start: number
  end: number
  type: string
}

/**
 * Collect non-overlapping PII hits: earliest start wins, and a longer match beats
 * a shorter one sharing the same start.
 */
export function collectHits(text: string, rules: Rule[]): PiiHit[] {
  const hits: PiiHit[] = []
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g'
    const regex = new RegExp(rule.pattern.source, flags.includes('d') ? flags : flags + 'd')
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const indices = match.indices
      const range = indices == null ? undefined : rule.groupIndex == null ? indices[0] : indices[rule.groupIndex]
      if (range) {
        const value = text.slice(range[0], range[1])
        if (!rule.validator || rule.validator(value)) {
          hits.push({ start: range[0], end: range[1], type: rule.type })
        }
      }
      if (match.index === regex.lastIndex) regex.lastIndex += 1
    }
  }

  hits.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end))
  const selected: PiiHit[] = []
  let lastEnd = -1
  for (const hit of hits) {
    if (hit.start < lastEnd) continue
    selected.push(hit)
    lastEnd = hit.end
  }
  return selected
}

function spliceHits(text: string, hits: PiiHit[], replace: (hit: PiiHit) => string): string {
  let result = ''
  let cursor = 0
  for (const hit of hits) {
    result += text.slice(cursor, hit.start)
    result += replace(hit)
    cursor = hit.end
  }
  return result + text.slice(cursor)
}

/** Replace every PII hit in `text` with a `[PII:TYPE:N]` placeholder. */
export function anonymize(text: string, vault: Vault, rules: Rule[]): AnonymizeResult {
  const hits = collectHits(text, rules)
  if (hits.length === 0) return { text, count: 0 }
  return {
    text: spliceHits(text, hits, (hit) => vault.register(hit.type, text.slice(hit.start, hit.end))),
    count: hits.length,
  }
}

export const REDACTED_RE = /\[REDACTED:[A-Z_]+\]/g

/**
 * One-way redaction for sinks that must never carry PII and can never be
 * un-redacted: each hit becomes a `[REDACTED:TYPE]` marker.
 *
 * Unlike `anonymize` this never touches the vault, so it is safe to run on the
 * synchronous telemetry capture path and the exported record carries no
 * reversible mapping. Already-safe markers (`[PII:...]`, `[REDACTED:...]`) are
 * not re-wrapped because no rule matches them.
 */
export function redactText(text: string, rules: Rule[]): string {
  const hits = collectHits(text, rules)
  if (hits.length === 0) return text
  return spliceHits(text, hits, (hit) => `[REDACTED:${hit.type}]`)
}

/** Replace `[PII:TYPE:N]` tokens back with their original values. Non-string input passes through untouched. */
export function restoreText(text: string, vault: Vault): string {
  return text.replace(TOKEN_RE, (token) => vault.lookup(token) ?? token)
}

/** Deep-scrub a JSON-serializable structure in place. */
export function scrubDeep(value: unknown, vault: Vault, rules: Rule[]): unknown {
  if (typeof value === 'string') return anonymize(value, vault, rules).text
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = scrubDeep(value[i], vault, rules)
    return value
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      ;(value as Record<string, unknown>)[key] = scrubDeep((value as Record<string, unknown>)[key], vault, rules)
    }
    return value
  }
  return value
}