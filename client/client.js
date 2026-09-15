// Bundled by scripts/build-client.mjs from client-src/index.js. Do not edit.
window.__ModuleLoader__.load({ id: "dsh-privacy-protector", factory: (require) => { "use strict"; var module = { exports: {} }; var exports = module.exports;
(() => {
/*
 * dsh-privacy-protector — client half (web).
 *
 * Renders a compact dropdown into the composer input's left tool row
 * (conversation.input.left slot, beside the input area):
 *  1. "全会话隐私保护" — global master switch (all sessions masked when ON)
 *  2. "隐私保护"       — per-session toggle (governed when global is OFF)
 *  3. "敏感话题守护"   — semantic disclosure guard (locks when induced)
 *
 * All are backed by the same /api/privacy-ctl loopback endpoint.
 */

const React = require('react')

const ENDPOINT = '/api/privacy-ctl'

function injectCss() {
  if (typeof document === 'undefined') return
  const selector = 'style[data-plugin="dsh-privacy-protector"][data-plugin-css="dsh-privacy-protector/style.css"]'
  if (document.querySelector(selector) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-privacy-protector'
  tag.dataset.pluginCss = 'dsh-privacy-protector/style.css'
  tag.textContent = [
    '.dsh-privacy-root {',
    '  position: relative;',
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: flex-start;',
    '  width: max-content;',
    '  max-width: 100%;',
    '}',
    '.dsh-privacy-select {',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  min-height: 26px;',
    '  padding: 2px 10px;',
    '  font-size: 12px;',
    '  line-height: 1.4;',
    '  border: 1px solid var(--dsw-specific-input-major, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)));',
    '  border-radius: 6px;',
    '  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08)));',
    '  color: var(--dsw-alias-label-secondary, var(--var-zile-system-tone-600));',
    '  cursor: pointer;',
    '  user-select: none;',
    '  white-space: nowrap;',
    '}',
    '.dsh-privacy-select:hover {',
    '  border-color: var(--dsw-alias-brand-primary, #3964ff);',
    '  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12));',
    '}',
    '.dsh-privacy-select.is-on {',
    '  color: var(--dsw-alias-brand-primary, var(--var-accent));',
    '  border-color: var(--dsw-alias-brand-primary, #3964ff);',
    '}',
    '.dsh-privacy-select.is-disabled {',
    '  opacity: 0.5;',
    '  cursor: not-allowed;',
    '}',
    '.dsh-privacy-chevron {',
    '  display: inline-block;',
    '  width: 7px;',
    '  height: 7px;',
    '  border-right: 1.5px solid currentColor;',
    '  border-bottom: 1.5px solid currentColor;',
    '  margin-left: 2px;',
    '  opacity: 0.7;',
    '  transform: rotate(-135deg);',
    '  transition: transform 0.18s ease;',
    '}',
    '.dsh-privacy-chevron.is-closed {',
    '  transform: rotate(45deg);',
    '}',
    '.dsh-privacy-panel {',
    '  position: absolute;',
    '  bottom: calc(100% + 4px);',
    '  left: 0;',
    '  z-index: 50;',
    '  display: flex;',
    '  flex-direction: column;',
    '  width: max-content;',
    '  max-width: 280px;',
    '  min-width: 200px;',
    '  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35));',
    '  border-radius: 8px;',
    '  overflow: hidden;',
    '  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-overlay, rgba(20,20,25,0.92)));',
    '  box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
    '  backdrop-filter: blur(8px);',
    '}',
    '.dsh-privacy-panel .dsh-privacy-toggle-row {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 6px;',
    '  min-height: 26px;',
    '  padding: 3px 10px;',
    '  font-size: 12px;',
    '  color: var(--dsw-alias-label-secondary, var(--var-zile-system-tone-600));',
    '  cursor: pointer;',
    '  user-select: none;',
    '  transition: background 0.12s ease;',
    '}',
    '.dsh-privacy-panel .dsh-privacy-toggle-row:hover:not(.is-disabled) {',
    '  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.1));',
    '}',
    '.dsh-privacy-panel .dsh-privacy-toggle-row + .dsh-privacy-toggle-row {',
    '  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2));',
    '}',
    '.dsh-privacy-panel input[type="checkbox"] {',
    '  accent-color: var(--dsw-alias-brand-primary, var(--var-accent));',
    '  cursor: pointer;',
    '}',
    '.dsh-privacy-panel .dsh-privacy-toggle-row.is-on {',
    '  color: var(--dsw-alias-brand-primary, var(--var-accent));',
    '}',
    '.dsh-privacy-panel .dsh-privacy-toggle-row.is-disabled {',
    '  opacity: 0.5;',
    '  cursor: not-allowed;',
    '}',
    '.dsh-privacy-panel .dsh-privacy-note {',
    '  padding: 3px 10px 6px;',
    '  font-size: 11px;',
    '  color: var(--dsw-alias-label-tertiary, var(--var-zile-system-tone-400));',
    '  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2));',
    '}',
    '.dsh-privacy-panel .dsh-privacy-note.is-error {',
    '  color: var(--dsw-alias-state-error-primary, var(--var-accent-danger, #d93036));',
    '}',
  ].join('\n')
  document.head.appendChild(tag)
}

async function getState(sessionId) {
  const res = await fetch(ENDPOINT, {
    method: 'GET',
    headers: { 'x-session-id': sessionId },
  })
  if (!res.ok) throw new Error('privacy-ctl ' + res.status)
  return res.json()
}

async function postState(sessionId, enabled, scope) {
  const body = { enabled }
  if (scope) body.scope = scope
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': sessionId },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('privacy-ctl ' + res.status)
  return res.json()
}

function PrivacyControls(props) {
  const sessionId = props.sessionId
  const [state, setState] = React.useState({ global: false, session: false, enabled: false, guardian: { armed: false, locked: false, categories: {}, total: 0 } })
  const [busy, setBusy] = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    setState({ global: false, session: false, enabled: false, guardian: { armed: false, locked: false, categories: {}, total: 0 } })
    setError(null)
    getState(sessionId).then(
      (payload) => {
        if (!cancelled) setState(payload)
      },
      (err) => {
        if (!cancelled) setError(err.message)
      },
    )
    return () => { cancelled = true }
  }, [sessionId])

  const toggleGlobal = () => {
    if (sessionId === undefined || busy) return
    const target = !state.global
    setBusy(true)
    setError(null)
    postState(sessionId, target, 'global').then(
      (payload) => { setState(payload); setBusy(false) },
      (err) => { setError(err.message); setBusy(false) },
    )
  }

  const toggleSession = () => {
    if (sessionId === undefined || busy) return
    const target = !state.session
    setBusy(true)
    setError(null)
    postState(sessionId, target).then(
      (payload) => { setState(payload); setBusy(false) },
      (err) => { setError(err.message); setBusy(false) },
    )
  }

  const toggleGuardian = () => {
    if (sessionId === undefined || busy) return
    const target = !(state.guardian && state.guardian.armed)
    setBusy(true)
    setError(null)
    postState(sessionId, target, 'guardian').then(
      (payload) => { setState(payload); setBusy(false) },
      (err) => { setError(err.message); setBusy(false) },
    )
  }

  const disabled = busy || sessionId === undefined
  const globalOn = state.global === true
  const sessionOn = state.session === true
  const effectiveOn = state.enabled === true
  const guardianOn = state.guardian && state.guardian.armed === true
  const guardianLocked = state.guardian && state.guardian.locked === true
  const guardianCats = (state.guardian && state.guardian.categories) || {}
  const guardianCount = (state.guardian && state.guardian.total) || 0

  const guardActive = guardianOn || guardianLocked
  const anyActive = globalOn || effectiveOn || guardActive
  const summary = guardianLocked
    ? (guardianCount > 0
        ? '锁定·已拦 ' + guardianCount
        : '已锁定')
    : anyActive
      ? (guardianCount > 0 ? '已拦 ' + guardianCount : '已开启')
      : '未开启'

const row = React.createElement

  // Select button (like the model picker) + dropdown panel.
  const selectClassName = 'dsh-privacy-select'
    + (anyActive ? ' is-on' : '')
    + (disabled ? ' is-disabled' : '')

  return row('div', { className: 'dsh-privacy-root' },
    row('div', {
      className: selectClassName,
      title: anyActive ? '隐私保护已开启' : '隐私保护未开启',
      onClick: () => {
        if (!disabled) setExpanded(!expanded)
      },
    },
      row('span', null, '隐私保护'),
      row('span', { className: 'dsh-privacy-toggle-state' + (guardianLocked ? ' is-error' : '') },
        summary),
      row('span', { className: 'dsh-privacy-chevron' + (expanded ? '' : ' is-closed') }),
    ),
    // Dropdown panel — only when expanded.
    expanded
      ? row('div', { className: 'dsh-privacy-panel' },
          // Row 1: global toggle (above per-session)
          row(
            'label',
            {
              className: 'dsh-privacy-toggle-row' + (globalOn ? ' is-on' : ''),
              title: '全会话隐私保护：开启后所有会话的输入均会被伪名化，无需逐个开启',
            },
            row('input', {
              type: 'checkbox',
              checked: globalOn,
              disabled: disabled,
              onChange: toggleGlobal,
            }),
            row('span', null, '全会话隐私保护'),
          ),
          // Row 2: per-session toggle
          row(
            'label',
            {
              className: 'dsh-privacy-toggle-row' + (effectiveOn && !globalOn ? ' is-on' : '') + (globalOn ? ' is-disabled' : ''),
              title: globalOn
                ? '全局保护已开启，此会话已生效'
                : '隐私保护：开启后发送给模型前会将姓名、电话、地址等伪名化',
            },
            row('input', {
              type: 'checkbox',
              checked: effectiveOn,
              disabled: disabled || globalOn,
              onChange: toggleSession,
            }),
            row('span', null, '隐私保护'),
          ),
          // Row 3: guardian (semantic disclosure protection)
          row(
            'label',
            {
              className: 'dsh-privacy-toggle-row' + (guardActive ? ' is-on' : '') + (guardianLocked ? ' is-disabled' : ''),
              title: guardianLocked
                ? '本会话刚被诱导透露出敏感信息，守护已锁定，无法手动关闭'
                : '敏感话题守护：开启后，向你索要健康、财务、工作机密、亲密关系等隐私的诱导提问将被拦截',
            },
            row('input', {
              type: 'checkbox',
              checked: guardActive,
              disabled: disabled || guardianLocked,
              onChange: toggleGuardian,
            }),
            row('span', null, '敏感话题守护' + (guardianLocked ? ' · 已锁定' : '')),
          ),
          // Note: guardian status or error, whichever applies.
          error !== null
            ? row('div', { className: 'dsh-privacy-note is-error' }, error)
            : (guardActive && guardianCount > 0)
              ? row('div', { className: 'dsh-privacy-note' },
                  guardianLocked
                    ? '检测到诱导提问，守护已锁定 · 已拦截 ' + guardianCount + ' 条敏感信息（' + Object.keys(guardianCats).join('/') + '）'
                    : '已拦截 ' + guardianCount + ' 条敏感信息（' + Object.keys(guardianCats).join('/') + '）')
              : (guardActive)
                ? row('div', { className: 'dsh-privacy-note' }, '守护中 · 尚未拦截敏感信息')
                : null,
        )
      : null,
  )
}

function apply(ctx) {
  injectCss()
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-privacy-protector-toggle',
        order: 1000,
      },
      PrivacyControls,
    ),
  )
}

module.exports = { apply, inject: ['slots', 'sessions'] }

})();
return module.exports; } });
