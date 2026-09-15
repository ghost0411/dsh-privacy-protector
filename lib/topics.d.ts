/**
 * Topic-level sensitive disclosure detection ("semantic guardian").
 *
 * Unlike rules.ts (which matches *formatted* PII like emails, cards, ids),
 * topic rules match *free-text disclosures* that a chat assistant commonly
 * fishes for: health, finances, work confidentiality, relationships, and
 * identity details. These are exactly the "诱导自报隐私" scenarios.
 *
 * Matching is deliberately conservative and context-gated:
 *   - a category keyword alone (e.g. "工资") is NOT enough;
 *   - it must co-occur with a disclosure verb/person/scale marker
 *     (我有 / 我的 / 每月 / 收入是 / 我和我老公 ...);
 *   - the disclosure is the *user* speaking about themselves.
 *
 * Output: the set of categories hit, plus the masked text where each hit is
 * replaced with a fast-path placeholder (never restored — the value is gone
 * before the model ever sees it).
 */
export type TopicCategory = 'HEALTH' | 'FINANCE' | 'WORK' | 'RELATIONSHIP' | 'IDENTITY';
export interface TopicRule {
    category: TopicCategory;
    /** Free-text disclosure pattern. Deliberately narrow to limit false hits. */
    pattern: RegExp;
}
export declare const TOPIC_RULES: TopicRule[];
export interface TopicHit {
    category: TopicCategory;
    start: number;
    end: number;
}
export interface TopicScanResult {
    /** Sensitive categories hit, in order of appearance (dedup symbol reuse). */
    categories: TopicCategory[];
    masked: string;
    /** True when at least one disclosure was found. */
    hit: boolean;
}
/**
 * Inducement rules: matching an ASSISTANT message. An inducement is a
 * leading question fishing for a sensitive disclosure ("你月薪多少",
 * "体检结果怎么样", "你和你老公关系如何"). These are the social-engineering
 * vector the guardian fights: when the model prompts like this, the session
 * becomes locked so the user cannot switch the guard off until the fishing
 * stops.
 */
export declare const INDUCE_RULES: RegExp[];
/**
 * Scan `text`, masking the innermost matched disclosure span for every rule.
 * Rules are applied non-overlapping (a later rule cannot match inside a span
 * an earlier rule already masked). Non-string / corrupt inputs return a no-hit
 * passthrough.
 */
export declare function scanTopics(text: string): TopicScanResult;
/**
 * Detect whether an assistant message fished for a sensitive disclosure.
 * The inducement rules deliberately match loose "you / your X ... how much"
 * phrasings so a locked session cannot slip through by rewording; normal
 * small-talk about the same nouns in a neutral register ("工资条怎么算")
 * does NOT match because it lacks the asker pose.
 */
export declare function hasInducement(text: string): boolean;
