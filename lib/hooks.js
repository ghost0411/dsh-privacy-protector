import { anonymize, restoreText } from './sanitizer.js';
import { scanTopics, hasInducement } from './topics.js';
/** Extract a session id from any `{ agent..., session }`-bearing payload. */
function sessionIdOf(payload) {
    const agent = payload?.agent;
    return agent?.session?.id;
}
/** Concatenated plain text of a message's text blocks. */
function textOf(message) {
    if (!Array.isArray(message.content))
        return '';
    return message.content
        .filter((b) => b !== null && typeof b === 'object')
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n');
}
/**
 * Detect an acted-on inducement: the latest assistant message fished for a
 * sensitive disclosure ("你月薪多少？") and the latest user message then
 * disclosed one ("我一个月挣 8k"). Only when BOTH hold does the session get
 * locked — a stray leading question with no follow-up disclosure is not an
 * inducement, and an unprompted disclosure is not an act of social engineering.
 */
function detectInducement(messages) {
    let assistantText = '';
    let userText = '';
    for (const message of messages) {
        if (!message || typeof message !== 'object')
            continue;
        if (message.role === 'assistant')
            assistantText = textOf(message);
        else if (message.role === 'user')
            userText = textOf(message);
    }
    if (!assistantText || !userText)
        return false;
    if (!hasInducement(assistantText))
        return false;
    return scanTopics(userText).hit;
}
export function registerHooks(ctx, vault, rules, isEnabled, log, guardian) {
    // 1. Sanitize what the model sees: rewrite text content blocks in the
    //    derived messages. Always calls next() (waterfall discipline).
    //    Gated per-session: OFF sessions pass straight through untouched.
    //    When a guardian is armed, free-text sensitive disclosures are ALSO
    //    masked (semantic layer) and their categories are counted per session.
    ctx.on('agent/pre-step', async (payload, next) => {
        const sessionId = sessionIdOf(payload);
        const decision = await next();
        if (decision?.kind !== 'enter' || !Array.isArray(decision.messages))
            return decision;
        const messages = decision.messages;
        let inducedFresh = false;
        if (guardian) {
            inducedFresh = detectInducement(messages);
            if (inducedFresh) {
                guardian.markInduced(sessionId);
                await log(`guardian locked session: assistant fished for a sensitive disclosure and user disclosed one`);
            }
        }
        // An induced session stays protected even after the user toggles the guard off.
        const protect = guardian ? guardian.shouldProtect(sessionId) : false;
        let masked = 0;
        let guardianMasked = 0;
        const scrubbed = messages.map((message) => {
            if (!message || typeof message !== 'object')
                return message;
            const nextMessage = { ...message };
            let messageChanged = false;
            const content = Array.isArray(nextMessage.content)
                ? nextMessage.content.map((block) => {
                    if (block?.type === 'text' && typeof block.text === 'string') {
                        let text = block.text;
                        if (isEnabled(sessionId)) {
                            const r = anonymize(text, vault, rules);
                            masked += r.count;
                            if (r.count > 0)
                                text = r.text;
                        }
                        if (protect) {
                            const scan = scanTopics(text);
                            if (scan.hit) {
                                for (const category of scan.categories)
                                    guardian.count(sessionId, category);
                                guardianMasked += 1;
                                text = scan.masked;
                            }
                        }
                        if (text !== block.text)
                            messageChanged = true;
                        return text !== block.text ? { ...block, text } : block;
                    }
                    return block;
                })
                : nextMessage.content;
            return messageChanged ? { ...nextMessage, content } : nextMessage;
        });
        if (masked > 0) {
            await log(`masked ${masked} sensitive value(s) before model call`);
            return { ...decision, messages: scrubbed };
        }
        if (guardianMasked > 0) {
            await log(`guardian masked ${guardianMasked} sensitive disclosure(s) (semantic)`);
            return { ...decision, messages: scrubbed };
        }
        return decision;
    });
    // 2. Restore tokens in the assistant stream so the user sees original values.
    ctx.on('llm/stream', async function* (options, next) {
        const upstream = await next();
        if (!isEnabled(options.sessionId)) {
            yield* upstream;
            return;
        }
        yield* restoreStream(upstream, vault);
    });
    // 3. Restore tokens in tool call arguments before a local tool executes.
    ctx.on('tools/pre-execute', async (execution, next) => {
        const sessionId = execution.agent?.session?.id;
        if (!isEnabled(sessionId))
            return next();
        const args = execution.args;
        const restored = restoreDeep(args, vault);
        if (restored !== undefined && args !== undefined && args !== null) {
            try {
                const target = args;
                for (const key of Object.keys(target)) {
                    ;
                    target[key] = restoreDeep(target[key], vault);
                }
            }
            catch {
                // frozen/shared object: fall through
            }
        }
        return next();
    });
}
function restoreDeep(value, vault) {
    if (typeof value === 'string')
        return restoreText(value, vault);
    if (Array.isArray(value)) {
        let changed = false;
        const out = value.map((item) => {
            const r = restoreDeep(item, vault);
            if (r !== item)
                changed = true;
            return r;
        });
        return changed ? out : value;
    }
    if (value !== null && typeof value === 'object') {
        let changed = false;
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            const r = restoreDeep(item, vault);
            if (r !== item)
                changed = true;
            out[key] = r;
        }
        return changed ? out : value;
    }
    return value;
}
/**
 * Wrap a StreamChunk iterable, restoring `[PII:...]` tokens inside
 * text-delta / reasoning-delta content and in fully-assembled text blocks.
 *
 * Streaming deltas can split a token across chunk boundaries, so a bare
 * per-chunk `restoreText` loses tokens (verified by test). We hold the
 * open-bracket tail per index and restore the remainder immediately.
 */
async function* restoreStream(upstream, vault) {
    const tails = new Map();
    const restoreDelta = (kind, index, text) => {
        const key = `${kind}:${index}`;
        const combined = (tails.get(key) ?? '') + text;
        const open = combined.lastIndexOf('[');
        let head;
        let tail;
        if (open >= 0 && !combined.slice(open).includes(']')) {
            head = combined.slice(0, open);
            tail = combined.slice(open);
        }
        else {
            head = combined;
            tail = '';
        }
        if (tail)
            tails.set(key, tail);
        else
            tails.delete(key);
        return restoreText(head, vault);
    };
    for await (const chunk of upstream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            yield { ...chunk, text: restoreDelta('text', chunk.index, chunk.text) };
        }
        else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
            yield { ...chunk, text: restoreDelta('reasoning', chunk.index, chunk.text) };
        }
        else if (chunk.type === 'block-end' && chunk.block && typeof chunk.block === 'object') {
            const block = chunk.block;
            if (block.type === 'text' && typeof block.text === 'string') {
                // Full serialized text; the flowing delta-tail buffer is no longer needed.
                tails.delete(`text:${chunk.index}`);
                yield { ...chunk, block: { ...block, text: restoreText(block.text, vault) } };
            }
            else {
                yield chunk;
            }
        }
        else {
            yield chunk;
        }
    }
}
