/**
 * Detection rules: same 9 rules as the original privacy_gateway project.
 * Each rule: [type, regex, validator?, groupIndex?]
 * groupIndex: when set, only the captured group is replaced (keyword itself kept).
 */

export interface Rule {
  type: string
  pattern: RegExp
  validator?: (value: string) => boolean
  groupIndex?: number
}

export function luhnValid(value: string): boolean {
  const digits = value.replace(/[\s-]/g, '')
  if (!/^\d{13,19}$/.test(digits)) return false
  let total = 0
  for (let i = digits.length - 1, dbl = false; i >= 0; i--, dbl = !dbl) {
    let d = digits.charCodeAt(i) - 48
    if (dbl) {
      d *= 2
      if (d > 9) d -= 9
    }
    total += d
  }
  return total % 10 === 0
}

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CODES = '10X98765432'

export function idCnValid(value: string): boolean {
  if (value.length !== 18 || !/^\d{17}/.test(value)) return false
  let total = 0
  for (let i = 0; i < 17; i++) {
    total += (value.charCodeAt(i) - 48) * ID_WEIGHTS[i]
  }
  return ID_CODES[total % 11] === value[17].toUpperCase()
}

export function ipv4Valid(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

export const DEFAULT_RULES: Rule[] = [
  { type: 'EMAIL', pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/ },
  { type: 'PHONE_CN', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  {
    type: 'ID_CN',
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
    validator: idCnValid,
  },
  { type: 'SSN_US', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { type: 'CREDIT_CARD', pattern: /\b(?:\d[ -]?){13,19}\b/, validator: luhnValid },
  { type: 'IP', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, validator: ipv4Valid },
  {
    type: 'API_KEY',
    pattern: /\b[a-zA-Z]*(?:api[_-]?key|secret|token)[a-zA-Z]*[=:\s]["']?[A-Za-z0-9_\-.]{8,}\b/i,
  },
  { type: 'SK_KEY', pattern: /\bsk-[A-Za-z0-9_\-]{16,}\b/ },
  {
    type: 'PASSWORD',
    pattern: /(?:密码|口令|password|passwd|pwd|pin|密码是|口令是)\s*[:：=]?\s*(?:为|is)?\s*([A-Za-z0-9_\-!@#$%^&*.]{4,64})/i,
    groupIndex: 1,
  },
]

export function compileRules(extra: Rule[] = []): Rule[] {
  return [...DEFAULT_RULES, ...extra]
}