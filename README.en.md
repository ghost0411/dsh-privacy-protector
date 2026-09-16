# dsh-privacy-protector — Privacy Protection Plugin for DeepSeek Harness

Built on the syntax-level pseudonymization mechanism of the `privacy_gateway` project, this plugin brings privacy protection to DeepSeek Harness (DSH) Desktop.

## Core Idea

Pre-send PII detection → replace with `[PII:type:index]` placeholders → the model only sees placeholders → restore the original values after the model replies.

On top of that, an optional **sensitive-topic guardian** detects chat assistants trying to coax users into disclosing sensitive topics (health, finance, work secrets, intimate relationships, etc.), masking the disclosure with `[屏蔽:类别:1]` before it is sent. The model never sees the raw text, and the conversation continues normally.

## Plugin Layout

```
dsh-privacy-protector/
├── package.json              # DSH bundle manifest
├── cordis.patch.yml          # plugin mount layer
├── tsconfig.json
├── src/
│   ├── index.ts              # plugin entry (apply + Config schema)
│   ├── vault.ts              # in-memory mapping table
│   ├── rules.ts              # 9 format rules + validators
│   ├── topics.ts             # 5 semantic sensitive-topic rules (guardian layer)
│   ├── guardian.ts           # guardian toggle + per-session category counters
│   ├── sanitizer.ts          # anonymize / restore / scrub utilities
│   └── hooks.ts              # DSH event hook registration
├── lib/                      # tsc build output
└── test/
    ├── sanitizer.test.mjs    # format rule detection / roundtrip / idempotency
    ├── topics.test.mjs       # semantic topic detection (hits / no false positives)
    ├── guardian.test.mjs     # guardian toggle + counters + persistence
    └── hooks.test.mjs        # hook robustness (fake ctx)
```

## DSH Event Hook Mapping

| opencode Hook | DSH/Cordis Event | Purpose |
|---|---|---|
| `experimental.chat.messages.transform` | `agent/pre-step` (waterfall) | pre-send masking + guardian topic masking |
| `experimental.chat.system.transform` | inside `agent/pre-step` | system prompt masking |
| `experimental.text.complete` | `llm/stream` (waterfall) | restore streaming text after the model replies |
| `tool.execute.before` | `tool-call-delta` on `llm/stream` | restore original values for local tool arguments (**not** `tools/pre-execute`, see below) |

> **Why tool-argument restoration is not on `tools/pre-execute`**: by the time that event fires,
> `exec.arguments` has already been **deep-frozen** by the tool registry, and `PreToolDecision` is
> only `allow`/`deny`/`ask` — a rewrite is not expressible in the type. Upstream documents this as
> deliberate, because logged and presented arguments would then desync from what actually runs.
> Restoration therefore happens on the streamed `tool-call-delta.argumentsDelta`: the last writable
> point before those fragments are assembled into the final tool-call block (which is then frozen
> and executed). `tools/pre-execute` is still observed, but **read-only** — it only warns when a
> placeholder reached a tool un-restored.

## Build & Test

```bash
npm install
npm run build            # contract type-check first, then tsc -> lib/ + client bundle
npm run test:contract    # compile-time contract against the real DSH types
npm test                 # node --test (inside the DSH sandbox run each file directly)
```

## Install into DSH Desktop

```bash
# dev install (link mode)
dsh plugin --profile web add link:/path/to/dsh-privacy-protector

# or install from a published bundle
dsh plugin --profile web add "github:ghost0411/dsh-privacy-protector#main"
```

`cordis.patch.yml` injects one line into the profile:

```yaml
- insert:
    - id: dsh-privacy-protector
      name: dsh-privacy-protector
      inject: [tools]
      config:
        enabled: true
        logMasked: true
        redactTelemetry: true
        extraRules: []
```

## Config Schema

```ts
interface Config {
  enabled: boolean          // default true
  logMasked: boolean        // default true, log masking activity
  redactTelemetry: boolean  // default true, strip PII from session-telemetry exports (see below)
  warnUnsafeSinks: boolean  // default true, probe for dangerous log-export sinks on first model request
  extraRules: [{ type: string; pattern: string; flags?: string; groupIndex?: number }]
}
```

## Telemetry redaction

`agent/pre-step` shields the **model**, not the **export**. The session log keeps restored
real values, and `@deepseek-ai/dsh-session-telemetry` mirrors session-log records onto
OTLP/HTTP with **no redaction rules of its own** (the deployment's own comment:
*so exports are the raw captured copy*):

- Default `FEEDBACK_ONLY`: recording `/feedback` uploads the session records since the last
  handoff to `harness-telemetry.deepseeksvc.com`.
- `DSH_TELEMETRY_MODE=FULL` uploads continuously; `DSH_TELEMETRY_OTLP_URL` can point anywhere.

This plugin mounts one-way redaction on the Service Definition's designated
`session-telemetry/record` waterfall: a hit becomes `[REDACTED:TYPE]` — **no vault write, not
reversible** (an exported copy never needs to be). The listener is synchronous, pure, does not
mutate its input, and bounds its walk to protect the capture hot path.

It is deliberately independent of the per-session privacy toggle: a telemetry record carries no
reliable session key, and shipping real PII to a collector is wrong in either toggle state.
Set `redactTelemetry: false` to switch it off wholesale.

> Scope: this fixes the **exported copy**. The canonical session log
> (`~/.dsh/sessions/**/session.jsonl.zstd`) still holds real values — the current DSH version
> exposes no usable pre-append hook. See `HANDOFF.md` 5.2.

## Sensitive-Topic Guardian

Chat assistants often use leading questions to coax users into revealing private information. With the guardian enabled, `agent/pre-step` runs a **semantic-level** scan before sending. Hits in any of the 5 categories below are masked to `[屏蔽:类别:1]` (never written back, so the model can never reconstruct the original):

| Category | Hit example (Chinese) | Non-hit example |
|---|---|---|
| FINANCE | 我月薪 3 万 / 我一个月挣 8k | 工资条怎么算扣除的？ |
| HEALTH | 我确诊了糖尿病 / 我爸有高血压 | 糖尿病饮食要注意什么？ |
| WORK | 我在XX公司做销售总监 | 如何做销售总监的季度汇报？ |
| RELATIONSHIP | 我和我老公感情不好 | 感情戏怎么写更自然？ |
| IDENTITY | (reserved) | — |

- The guardian toggle is independent of the two pseudonymization toggles (global / per-session) and is controlled via `POST /api/privacy-ctl { scope: 'guardian' }`, persisted in `toggles.json`.
- Detection counters accumulate per session and category; the status area below the composer shows a live "N sensitive entries blocked".
- **Induced-lock (anti-social-engineering)**: if an assistant asks for private data ("What's your salary?") and the user then actually discloses it, the session is **locked** immediately:
  - Even if the user manually disables the guardian (or an attacker tries to through UI/script), masking continues server-side (a `POST` to disable returns `403` while locked).
  - The checkbox becomes disabled with a "locked" label and cannot be unlocked during the induced session.
  - The lock lives only in process memory (never written to `toggles.json`); restarting or starting a new session clears it naturally.
- Matching is intentionally conservative: a keyword alone ("salary") does not trigger; it must co-occur with a self-reference marker (我/我爸/我的 etc.) to count as a leak. Inducement detection also requires both "really asked" + "really disclosed" to lock.

## Key Design

### 1. Vault — token↔original mapping table

ONE GLOBAL INSTANCE per process, shared by every session (created once in `apply()`). Tokens are
numbered per TYPE only (`[PII:EMAIL:0]`), **not** per session — session isolation lives in the
*toggle*, not here.

Since v0.3.0 it **does survive a restart**: the mapping is encrypted with Electron `safeStorage`
(DPAPI on Windows) before being written to
`$DSH_HOME/storages/dsh-privacy-protector/vault.json`. Without safeStorage it degrades to
memory-only — PII is never written in cleartext.

### 2. The 9 interception rules

| # | Type | RegExp/validation | Notes |
|---|---|---|---|
| 1 | EMAIL | standard email regex | — |
| 2 | PHONE_CN | `1[3-9]\d{9}` | 11-digit Chinese mobile |
| 3 | ID_CN | 18 digits + checksum validation | Chinese national ID |
| 4 | SSN_US | `\d{3}-\d{2}-\d{4}` | US SSN |
| 5 | CREDIT_CARD | 13-19 digits + Luhn validation | bank card |
| 6 | IP | IPv4, four octets ≤255 | — |
| 7 | API_KEY | assignment of values beside api_key/secret/token keywords | — |
| 8 | SK_KEY | `sk-` prefixed keys | — |
| 9 | PASSWORD | fires only when a keyword is adjacent | avoids false hits on plain numbers |

### 3. Password rule (keyword context)

```ts
/(?:密码|口令|password|passwd|pwd|pin|密码是|口令是)\s*[:：=]?\s*(?:为|is)?\s*([A-Za-z0-9_\-!@#$%^&*.]{4,64})/i
// groupIndex=1: only group 1 is masked; the keyword itself is preserved
```

### 4. Model sees placeholders; users see originals

- Pre-send: `agent/pre-step` rewrites messages to placeholders → the model only processes sanitized content
- Post-answer: `llm/stream` wraps the stream and restores each chunk to the original → the user sees real values
- Local tools: the same `llm/stream` hook restores values inside `tool-call-delta.argumentsDelta`, so a
  tool receives the **original** value (restored values are JSON-escaped, so a value containing `"`
  cannot corrupt the argument JSON)

### 5. Sensitive-topic guardian

- Complements format rules: format rules catch "shaped PII", the guardian catches "free-text sensitive self-reports"
- Masking is not written back (no vault registration), so the model cannot recover the original through placeholder context
- Counters are persisted per session; they survive restarts and the UI shows per-category totals
- **Inducement detection reads session history**: `agent/pre-step`'s `payload.messages` is only the
  claimed USER batch for the current turn and structurally never contains an assistant message, so the
  assistant side comes from `payload.agent.session.deriveMessages()`

### 6. Security boundary notes

- **Not protected**: obfuscated variants (e.g. `alice [at] qq`), names/addresses/organizations, unstructured secrets
- **Password rule limits**: only fires when a keyword is adjacent; arbitrary digit strings cannot be
  caught, and a quoted value (`password = "s3cret"`) is **not** captured — all three implementations
  agree, so this is a known gap rather than a divergence
- **Guardian false positives/negatives**: the semantic rules are a conservative approximation; complex phrasing may slip through, and neutral questions should not be flagged
- **The canonical session log contains real PII, and the current DSH version cannot fix it**: DSH writes
  the **restored originals** into the durable session log
  (`~/.dsh/sessions/<workspace>/session.jsonl.zstd`, zstd-compressed but **never encrypted**). There is
  no pre-append hook (verified: `session/event` is post-commit, `session-telemetry/record` only affects
  the exported copy, `tools/ptc-dispatch-log` only covers `run_code` sub-dispatches). Any plugin that
  reads session content still sees the originals — in this profile, `dsh-cost-meter`,
  `@openviking/dsh-memory-plugin` (which persist into a memory store) and `dsh-context`.
- **Keep `dsh-session-log-deepseek` disabled**: with `enabled: true` it uploads the **raw session log**
  to the DeepSeek API as the `dsh_session_log` request field, and there is no redaction hook to mount.
  It defaults to `enabled: false`. This plugin probes for it on this session's first model request and
  logs a **DANGER** line when it is active (silence it with `warnUnsafeSinks: false`) — **a warning is
  not a fix**.
- **Telemetry export** is redacted (`session-telemetry/record`, one-way `[REDACTED:TYPE]`).

## Upstream API Compatibility Note

DSH is in developer preview (`SESSION_FORMAT_VERSION = 0`); event signatures may change.
**This plugin no longer hand-writes event shapes**: the declarations for `agent/pre-step`,
`llm/stream` and `tools/pre-execute` come from upstream packages themselves
(`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-tools`, imported as devDependencies), and
`tsconfig.contract.json` + `test/types/dsh-contract.ts` make an upstream field rename a **build
failure** instead of a silent no-op. `test/contract.test.mjs` re-checks the real `.d.ts` at run time.
Loader robustness tests cover abnormal input; failing hook logic never blocks a session.