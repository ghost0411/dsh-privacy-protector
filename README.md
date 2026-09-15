# dsh-privacy-protector

> Privacy protection plugin for DeepSeek Harness (DSH) Desktop.
> 为 DeepSeek Harness (DSH) 桌面端打造的隐私保护插件。

Pre-send PII pseudonymization + sensitive-topic guardian with induced-lock protection.

发送前 PII 伪名化 + 带诱导锁定机制的敏感话题守护。

---

## 🌐 Language / 语言

| 🇺🇸 English | 🇨🇳 简体中文 |
|:---:|:---:|
| [English](README.en.md) | [中文](README.zh-CN.md) |

---

## Features / 功能特性

- **Syntax-level PII masking** — 语法级 PII 脱敏
  EMAIL / PHONE_CN / ID_CN / SSN_US / CREDIT_CARD / IP / API_KEY / SK_KEY / PASSWORD
- **Model sees placeholders, users see originals** — 模型只见占位符，用户只见原文
- **Sensitive-topic guardian**（诱导锁定 anti-social-engineering）— 敏感话题守护
- Per-session & global toggles — 会话级 / 全局开关

## Install / 安装

```bash
dsh plugin --profile web add "github:your-name/dsh-privacy-protector#main"
```

Full docs in [English](README.en.md) / 完整文档见 [中文](README.zh-CN.md).

---

**License:** Apache-2.0 · 许可证见 [LICENSE](LICENSE)