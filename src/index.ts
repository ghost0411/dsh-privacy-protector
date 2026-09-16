import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createVault } from './vault.js'
import { compileRules, type Rule } from './rules.js'
import { registerHooks } from './hooks.js'
import { createToggleRegistry } from './toggle.js'
import { createGuardian } from './guardian.js'
import { createPrivacyCtlHandler, type HttpLikeRequest, type HttpLikeResponse } from './privacyCtl.js'
import { createToggleFileStore, createVaultFileStore, dataDir, detectSafeStorage } from './store.js'
import { installTelemetryRedaction } from './telemetry.js'
import { probeSessionLogUpload } from './dshSafety.js'

// `webServer` is declared here because the plugin may be loaded without the
// host webserver package present. `tools` and `sessions` are NOT redeclared:
// their real service types come from `@deepseek-ai/dsh-tools` /
// `@deepseek-ai/dsh-session`, and a locally invented shape would be a second
// source of truth for the same service.
declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'prefix' | 'exact'
        path: string
        handler: (req: HttpLikeRequest, res: HttpLikeResponse) => void | Promise<void>
      }): () => void
    }
  }
}

declare const console: { log: (...args: unknown[]) => void }

export const name = 'dsh-privacy-protector'

export const inject = ['tools', 'sessions', 'webServer']

export interface ExtraRuleConfig {
  type: string
  pattern: string
  flags?: string
  groupIndex?: number
}

export interface Config {
  enabled: boolean
  logMasked: boolean
  redactTelemetry: boolean
  /** Warn (once per process) when a plugin would export the raw session log. */
  warnUnsafeSinks: boolean
  extraRules: ExtraRuleConfig[]
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  logMasked: Schema.boolean().default(true),
  redactTelemetry: Schema.boolean().default(true),
  warnUnsafeSinks: Schema.boolean().default(true),
  extraRules: Schema.array(
    Schema.object({
      type: Schema.string(),
      pattern: Schema.string(),
      flags: Schema.string().default(''),
      groupIndex: Schema.number().default(0),
    }),
  ).default([]),
})

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return
  // Disk persistence: toggles.json is plain (no secrets); vault.json is
  // encrypted with safeStorage (DPAPI on Windows). When safeStorage is
  // unavailable the vault stays memory-only and PII never touches disk.
  const dir = dataDir()
  const toggleStore = createToggleFileStore(dir)
  const encryptor = detectSafeStorage()
  const vaultStore = createVaultFileStore(dir, encryptor)

  // Persist toggles + guardian together on every change (single small JSON write).
  let toggles!: ReturnType<typeof createToggleRegistry>
  let guardian!: ReturnType<typeof createGuardian>
  const persist = () => {
    try { toggleStore.save({ ...toggles.snapshot(), guardian: guardian.snapshot() }) } catch { /* storage is best-effort */ }
  }
  toggles = createToggleRegistry(persist)
  guardian = createGuardian(persist)

  // Persist the vault debounced: masking can register many values in a burst.
  let saveTimer: NodeJS.Timeout | undefined
  let vault!: ReturnType<typeof createVault>
  const flushVault = () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined }
    try { vaultStore.save(vault.snapshot()) } catch { /* best-effort */ }
  }
  vault = createVault(() => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(flushVault, 500)
  })

  // Restore prior state: unknown/foreign files degrade to fresh defaults.
  const loaded = toggleStore.load()
  toggles.load(loaded)
  guardian.load(loaded?.guardian)
  vault.load(vaultStore.load())

  const rules: Rule[] = [
    ...compileRules(),
    ...config.extraRules.map((extra) => ({
      type: extra.type,
      pattern: new RegExp(extra.pattern, extra.flags ?? ''),
      ...(extra.groupIndex ? { groupIndex: extra.groupIndex } : {}),
    })),
  ]
  // Per-session + global toggle registry: every session starts OFF, global starts OFF.

  /** Single logging path; must never break the conversation. */
  const notify = (message: string) => {
    try {
      if (typeof ctx.logger === 'function') ctx.logger('privacy-protector')?.info?.(message)
      else console.log('[privacy-protector]', message)
    } catch {
      // logging must never break the conversation
    }
  }

  registerHooks(ctx, vault, rules, (sessionId) => toggles.isEnabled(sessionId), (message) => {
    if (config.logMasked) notify(message)
  }, guardian, () => {
    // The canonical session log holds the REAL values this plugin restored, and
    // no supported hook can rewrite it. Some sinks can still be called out — see
    // src/dshSafety.ts and the README "Known exposure" section.
    if (!config.warnUnsafeSinks) return
    const probe = probeSessionLogUpload(ctx)
    if (probe.state === 'registered') {
      notify(
        `DANGER: ${probe.note}. ` +
          'The session log contains unredacted PII and has no redaction hook. ' +
          'Disable dsh-session-log-deepseek (its `enabled` config) or stop using this plugin with it.',
      )
    }
  })

  // Redact PII in outbound session-telemetry records. The canonical session log
  // keeps real values (a restored assistant reply is appended verbatim), and the
  // telemetry coordinator mirrors session-log records onto OTLP with no redaction
  // rules of its own, so this is the one export path a supported extension point
  // can close. Runs regardless of the per-session masking toggle — see telemetry.ts.
  if (config.redactTelemetry) installTelemetryRedaction(ctx, rules)

  // On plugin unload / process teardown, flush any pending debounced vault
  // write so the last few registered tokens are not lost.
  ctx.effect(() => () => {
    try {
      persist()
      flushVault()
    } catch { /* best-effort */ }
  })

  // Loopback route for the client checkbox. webServer is declared in `inject`;
  // the host sandbox exposes it via the injected property, but some sandbox
  // facades only materialize it through ctx.get. Try both, always under
  // undefined checks so an unavailable service degrades to no route.
  try {
    const probeCtx = ctx as unknown as { webServer?: unknown; get?: (n: string) => unknown }
    let webServer: unknown
    try {
      webServer = probeCtx.webServer
    } catch {
      webServer = undefined
    }
    if (webServer == null || typeof (webServer as { register?: unknown }).register !== 'function') {
      const viaGet = probeCtx.get?.('webServer')
      if (viaGet != null && typeof (viaGet as { register?: unknown }).register === 'function') webServer = viaGet
    }
    if (webServer != null && typeof (webServer as { register: unknown }).register === 'function') {
      ctx.effect(() =>
        (webServer as { register: (r: unknown) => () => void }).register({
          kind: 'prefix',
          path: '/api/privacy-ctl',
          handler: createPrivacyCtlHandler({}, toggles, guardian),
        }),
      )
    }
  } catch {
    // route registration is best-effort; the plugin keeps working without it
  }
}

export { createToggleRegistry } from './toggle.js'
export { createPrivacyCtlHandler, categoryLabel } from './privacyCtl.js'
export { createGuardian } from './guardian.js'
export { scanTopics, TOPIC_RULES } from './topics.js'
export type { TopicCategory, TopicScanResult } from './topics.js'
export type { Guardian, GuardianSnapshot } from './guardian.js'
export type { ToggleRegistry } from './toggle.js'
export type { HttpLikeRequest, HttpLikeResponse, PrivacyCtlDeps } from './privacyCtl.js'
export { createToggleFileStore, createVaultFileStore, dataDir, detectSafeStorage } from './store.js'
export { probeSessionLogUpload, DSH_SESSION_LOG_FIELD } from './dshSafety.js'
export type { SessionLogUploadProbe, SessionLogUploadState } from './dshSafety.js'
export type { ToggleFileStore, VaultFileStore, Encryptor } from './store.js'