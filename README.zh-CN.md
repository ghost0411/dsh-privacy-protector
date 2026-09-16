# dsh-privacy-protector — DeepSeek Harness 隐私保护插件

基于 `privacy_gateway` 项目的语法级伪名化机制，为 DeepSeek Harness (DSH) 桌面端打造的隐私保护插件。

## 核心原理

发送前 PII 识别 → 替换为 `[PII:类型:序号]` 占位符 → 模型只见占位符 → 回答后还原。

此外，可选「敏感话题守护」：检测聊天助手诱导用户自报敏感话题（健康、财务、
工作机密、亲密关系等自由文本），在发送前用 `[屏蔽:类别:1]` 遮挡，模型看不到
原始内容，对话正常继续。

## 插件结构

```
dsh-privacy-protector/
├── package.json              # DSH bundle manifest
├── cordis.patch.yml          # 插件挂载层
├── tsconfig.json
├── src/
│   ├── index.ts              # 插件入口 (apply + Config schema)
│   ├── vault.ts              # 内存映射表
│   ├── rules.ts              # 9 条格式规则 + 校验器
│   ├── topics.ts             # 5 类语义敏感话题规则（守护层）
│   ├── guardian.ts           # 守护开关 + 每会话分类计数
│   ├── sanitizer.ts          # anonymize / restore / scrub 工具函数
│   └── hooks.ts              # DSH 事件钩子注册
├── lib/                      # tsc 编译产物
└── test/
    ├── sanitizer.test.mjs    # 格式规则检测 / roundtrip / 幂等
    ├── topics.test.mjs       # 语义话题检测（命中/不误伤）
    ├── guardian.test.mjs     # 守护开关 + 计数 + 持久化
    └── hooks.test.mjs        # 钩子鲁棒性（fake ctx）
```

## DSH 事件钩子映射

| opencode Hook | DSH/Cordis 事件 | 作用 |
|---|---|---|
| `experimental.chat.messages.transform` | `agent/pre-step` (waterfall) | 发送前脱敏 + 守护话题遮挡 |
| `experimental.chat.system.transform` | `agent/pre-step` 内处理 | system prompt 脱敏 |
| `experimental.text.complete` | `llm/stream` (waterfall) | 模型回答后还原 streaming text |
| `tool.execute.before` | `llm/stream` 的 `tool-call-delta` | 本地工具参数还原（**不是** `tools/pre-execute`，见下） |

> **为什么工具参数还原不在 `tools/pre-execute`**：该事件的 `exec.arguments` 已被工具注册表
> **深度冻结**，且 `PreToolDecision` 只有 `allow`/`deny`/`ask`——**类型层面表达不出「改写入参」**，
> 上游文档也明确写着这是有意的设计（否则日志/呈现的参数会与实际执行脱钩）。
> 所以还原挂在 `llm/stream` 的流式 `tool-call-delta.argumentsDelta` 上：那是被拼接成
> 最终 tool-call block（随后冻结、执行）**之前最后一个可写点**。
> `tools/pre-execute` 仍被监听，但**只读**——它只负责在发现「占位符没被还原就到达了工具」时打警告。

## 构建与测试

```bash
npm install
npm run build            # 先跑契约类型检查，再 tsc -> lib/ + client bundle
npm run test:contract    # 与真实 DSH 类型的编译期契约（字段名写错即失败）
npm test                 # node --test（沙箱内改用逐个 node test\<name>.test.mjs）
```

## 安装到 DSH Desktop

```bash
# 本地开发安装（link 方式）
dsh plugin --profile web add link:/path/to/dsh-privacy-protector

# 或作为 bundle 发布后安装
dsh plugin --profile web add "github:ghost0411/dsh-privacy-protector#main"
```

`cordis.patch.yml` 会向 profile 插入一行：

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

## 配置 Schema

```ts
interface Config {
  enabled: boolean          // 默认 true
  logMasked: boolean        // 默认 true，记录脱敏日志
  redactTelemetry: boolean  // 默认 true，从会话遥测导出中抹掉 PII（见下）
  warnUnsafeSinks: boolean  // 默认 true，首次发模型请求时探测并警告危险的日志导出 sink
  extraRules: [{ type: string; pattern: string; flags?: string; groupIndex?: number }]
}
```

## 遥测脱敏

`agent/pre-step` 只挡住**模型**，挡不住**导出**。会话日志里存的是还原后的真实值，
而 `@deepseek-ai/dsh-session-telemetry` 会把会话日志记录镜像到 OTLP/HTTP，
**自身不带任何脱敏规则**（部署注释原文：*so exports are the raw captured copy*）：

- 默认 `FEEDBACK_ONLY`：你点 `/feedback` 时，自上次交接以来的会话记录会上传到
  `harness-telemetry.deepseeksvc.com`。
- `DSH_TELEMETRY_MODE=FULL` 会持续上传；`DSH_TELEMETRY_OTLP_URL` 可指向任意采集器。

本插件在官方指定的 `session-telemetry/record` waterfall 上挂单向脱敏：命中规则的值变成
`[REDACTED:类型]`，**不写入 vault、不可逆**（导出副本本就无需可还原）。该监听是同步的、
纯函数的、不改入参，且遍历有深度与节点上限以保护捕获热路径。

与逐会话的「隐私保护」开关**无关**：遥测记录没有可靠的会话键，且把真实 PII 传给采集器
在任何开关状态下都不应发生。想整体关掉就设 `redactTelemetry: false`。

> 注意范围：这里修的是**导出副本**。会话日志本体（`~/.dsh/sessions/**/session.jsonl.zstd`）
> 仍保存真实值——当前 DSH 版本没有可用的"写入日志前"钩子，详见 `HANDOFF.md` 5.2。

## 敏感话题守护（guardian）

对话助手常通过引导式提问诱导用户自报隐私。开启「敏感话题守护」后，`agent/pre-step`
在发送前对用户文本做**语义级**扫描，命中以下 5 类即遮挡为 `[屏蔽:类别:1]`（不回写，
模型永远看不到原文）：

| 类别 | 示例（命中） | 示例（不误伤） |
|---|---|---|
| FINANCE | 我月薪 3 万 / 我一个月挣 8k | 工资条怎么算扣除的？ |
| HEALTH | 我确诊了糖尿病 / 我爸有高血压 | 糖尿病饮食要注意什么？ |
| WORK | 我在XX公司做销售总监 | 如何做销售总监的季度汇报？ |
| RELATIONSHIP | 我和我老公感情不好 | 感情戏怎么写更自然？ |
| IDENTITY | （预留，后续补充） | — |

- 守护开关独立于「全会话隐私保护」/「会话隐私保护」两个伪名化开关，通过
  `POST /api/privacy-ctl { scope: 'guardian' }` 控制，持久化于 `toggles.json`。
- 每会话按类别累计遮挡计数，composer 下方状态区实时显示「已拦截 N 条敏感信息」。
- **诱导锁定（反社会工程）**：若助手发问索取隐私（"你月薪多少？"）且随后用户
  真的自报了敏感信息，该会话立即被**锁定**：
  - 即便用户手动关掉守护开关（或诱导方通过 UI/脚本尝试关闭），服务端仍继续遮挡
    （`POST` 关闭请求在锁定态返回 `403`）
  - 复选框变为禁用并显示「已锁定」，无法在诱导会话中解除
  - 锁定只在进程内存中存在（不进 `toggles.json`），重启/新会话自然解除
- 匹配故意保守：关键词单独出现（如"工资"）不触发，必须与自述标记（我/我爸/我的等）
  同现才算泄露，避免误伤一般性提问；诱导检测同样仅在"真的问 + 真的答"双命中时锁定。

## 关键设计

### 1. Vault — token↔原文映射表

**进程内全局单例**，所有会话共用（`apply()` 里创建一次），token 只按类型编号
（`[PII:EMAIL:0]`），**不按会话隔离**——会话隔离体现在*开关*上，不在 vault 上。

v0.3.0 起**会跨重启恢复**：映射表经 Electron `safeStorage`（Windows 即 DPAPI）加密后写入
`$DSH_HOME/storages/dsh-privacy-protector/vault.json`。拿不到 safeStorage 时降级为纯内存，
**绝不写明文 PII**。

### 2. 9 条拦截规则

| # | 类型 | 正则/校验 | 备注 |
|---|---|---|---|
| 1 | EMAIL | 标准邮箱正则 | — |
| 2 | PHONE_CN | `1[3-9]\d{9}` | 11 位中国手机 |
| 3 | ID_CN | 18 位 + 校验码验证 | 身份证 |
| 4 | SSN_US | `\d{3}-\d{2}-\d{4}` | 美国 SSN |
| 5 | CREDIT_CARD | 13-19 位 + Luhn 校验 | 银行卡 |
| 6 | IP | IPv4 四段 + ≤255 | — |
| 7 | API_KEY | 含 api_key/secret/token 关键词的赋值串 | — |
| 8 | SK_KEY | `sk-` 开头密钥 | — |
| 9 | PASSWORD | 关键词紧邻时触发 | 防止误伤普通数字 |

### 3. 密码规则（关键词上下文）

```ts
/(?:密码|口令|password|passwd|pwd|pin|密码是|口令是)\s*[:：=]?\s*(?:为|is)?\s*([A-Za-z0-9_\-!@#$%^&*.]{4,64})/i
// groupIndex=1：只脱敏捕获组 1，关键词本身保留
```

### 4. 模型只见占位符，用户只见原文

- 发送前：`agent/pre-step` 把消息改为占位符 → 模型只处理脱敏内容
- 回答后：`llm/stream` 包装流，逐 chunk 还原为原文 → 用户看到真实值
- 本地工具：同一个 `llm/stream` 钩子在 `tool-call-delta.argumentsDelta` 上还原参数，
  所以工具拿到的是**原文**（还原值会做 JSON 转义，避免值里含 `"` 时把参数 JSON 弄坏）

### 5. 敏感话题守护（guardian）

- 与格式规则互补：格式规则抓「形态化 PII」，守护抓「自由文本敏感自报」
- 遮挡不回写（不注册 vault），杜绝模型通过占位符上下文还原
- 计数按会话持久化，重启不丢失；可在 UI 看到每个话题类别的拦截量
- **诱导检测读的是会话历史**：`agent/pre-step` 的 `payload.messages` 只是本回合
  「被 claim 的用户批次」，**结构上不含 assistant 消息**，所以 assistant 侧必须取自
  `payload.agent.session.deriveMessages()`

### 6. 安全边界提示

- **不保护**：变形写法（如 `alice [at] qq`）、姓名/地址/组织名、非结构化机密
- **密码规则限制**：只在关键词紧邻时触发，无法拦截任意数字串；带引号的密码值
  （`password = "s3cret"`）**不会**被捕获——三套实现一致，属已知缺口
- **守护误报/漏报**：语义规则是保守近似，复杂表述可能漏判，中性提问不应误伤
- **会话日志本体含真实 PII（当前 DSH 版本无法修）**：DSH 把**还原后的原文**写进权威会话日志
  （`~/.dsh/sessions/<workspace>/session.jsonl.zstd`，仅 zstd 压缩、**未加密**）。已核实没有
  append 前的可写 hook（`session/event` 是 post-commit；`session-telemetry/record` 只改导出副本；
  `tools/ptc-dispatch-log` 只管 `run_code` 子分发）。因此**直接读会话内容的下游**仍会拿到原文，
  例如 `dsh-cost-meter`、`@openviking/dsh-memory-plugin`（会写进记忆库）、`dsh-context`。
- **`dsh-session-log-deepseek` 必须保持关闭**：`enabled: true` 时它会把**权威会话日志原文**
  作为 `dsh_session_log` 请求字段上传到 DeepSeek API，且没有任何脱敏 hook 可挂。它默认
  `enabled: false`。本插件会在本会话首次发起模型请求时探测它，命中就打印一条 **DANGER** 日志
  （可用 `warnUnsafeSinks: false` 关闭该提示）——**提示不等于修复**。
- **遥测导出**已脱敏（`session-telemetry/record`，单向 `[REDACTED:TYPE]`）。

## 与上游 API 的兼容性注意

DSH 处于开发者预览期（SESSION_FORMAT_VERSION = 0），事件签名可能变化。**本插件不再手写事件形状**：
`agent/pre-step` / `llm/stream` / `tools/pre-execute` 的声明来自上游包本身
（`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-tools`，作为 devDependency 引入），
`tsconfig.contract.json` + `test/types/dsh-contract.ts` 会在上游改字段时**直接编译失败**。
`test/contract.test.mjs` 另在运行期核对真实 `.d.ts`。加载器鲁棒性测试覆盖异常输入，
钩子逻辑失败不会阻断会话。