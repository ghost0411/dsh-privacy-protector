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
/**
 * Usual disclosure markers that indicate the speaker is volunteering
 * personal facts (vs. asking a neutral question like "工资怎么算").
 */
const SELF_REF = '(?:我|本人|自己|我们家|我们单位|我们公司|我爸|我妈|我爸妈|我的|自己的|我手头)';
const NUM = '(?:[0-9一二三四五六七八九十百千万两]+)';
export const TOPIC_RULES = [
    {
        category: 'FINANCE',
        pattern: new RegExp(`${SELF_REF}(?:每?月|年)?(?:大概|大约)?(?:工资|月薪|年薪|薪资|薪水|收入|存款|积蓄|身价|股票|基金|理财|负债|欠款|房贷|车贷|信用卡)[\\s是大概约]*${NUM}(?:万|千|块|元)?`),
    },
    {
        category: 'FINANCE',
        // "我月入 3 万 / 我一个月挣 8k / 我年收入 30 万"
        pattern: new RegExp(`${SELF_REF}(?:大概|大约)?(?:(?:每|一)?个?月|年)?(?:挣|赚|入账|到手|工资到手|收入)[\\s是大概约]*${NUM}(?:万|千|k|w|块|元)?`),
    },
    {
        category: 'HEALTH',
        pattern: new RegExp(`${SELF_REF}(?:患有|得了|确诊了?|查出(?:过)?|诊断出|有)?(?:糖尿病|高血压|心脏病|乙肝|癌症|肿瘤|抑郁症|焦虑症|失眠|肾病|尿毒症|白血病|化疗)`),
    },
    {
        category: 'HEALTH',
        // Disease clause after a separator ("，有糖尿病" / "。确诊了癌症")
        pattern: new RegExp(`(?:[，。；,])(?:还)?(?:有|得了|患了|确诊了?|查出)(?:糖尿病|高血压|心脏病|乙肝|癌症|肿瘤|抑郁症|焦虑症|失眠|肾病|尿毒症|白血病|化疗)`),
    },
    {
        category: 'HEALTH',
        pattern: new RegExp(`${SELF_REF}每?(?:天|日)?(?:在?吃|在?服用|需要打|在?(?:吃)??)、(?:降压药|降糖药|安眠药|止痛药|抗抑郁药|胰岛素|化疗药|避孕药)`),
    },
    {
        category: 'WORK',
        pattern: new RegExp(`${SELF_REF}在.+?(?:公司|单位|部门|团队|厂子)做(.{1,20}?)`),
    },
    {
        category: 'WORK',
        pattern: new RegExp(`${SELF_REF}(?:负责|搞|管|经手|接触|处理).{0,12}(?:核心|机密|保密|客户|报价|成本|财务收支|采购|招标|源代码|源码|配方|研发计划)`),
    },
    {
        category: 'RELATIONSHIP',
        pattern: new RegExp(`${SELF_REF}(?:和|跟|与)(?:我)?(?:老公|老婆|丈夫|妻子|男朋友|女朋友|男友|女友|对象|伴侣|另一半|孩子|父母|婆婆|岳母)(?:的?)(?:感情|关系|性生活|房事|坐月子|离婚|吵架|冷战|出轨|家暴|性格)`),
    },
    {
        category: 'RELATIONSHIP',
        pattern: new RegExp(`${SELF_REF}(?:最近|现在)?(?:和|跟|与).{0,8}(?:吵架|闹离婚|冷战|分手|离婚)`),
    },
];
const PLACEHOLDER = (category) => `[屏蔽:${category}:1]`;
/**
 * Inducement rules: matching an ASSISTANT message. An inducement is a
 * leading question fishing for a sensitive disclosure ("你月薪多少",
 * "体检结果怎么样", "你和你老公关系如何"). These are the social-engineering
 * vector the guardian fights: when the model prompts like this, the session
 * becomes locked so the user cannot switch the guard off until the fishing
 * stops.
 */
export const INDUCE_RULES = [
    // "你/你的 X ... 多少/怎么样/如何/什么情况"
    new RegExp(`(?:你|您)(?:的)?(?:(?:一?个?月|每月|每年|现在)?的)?`
        + `(?:工资|月薪|年薪|薪资|收入|存款|工资条|银行卡|余额|负债|房贷)`
        + `[\\s是大概约]*(?:多少|多少呢|是多少|几|怎么样|怎样|如何|什么情况|多少收入)`),
    new RegExp(`(?:你|您)(?:的)?(?:体检|体检报告|病历|病况|病情|血压|血糖|体重|身高|吃药|用药|检查结果)`
        + `[\\s是大概约]*(?:多少|怎么|怎么样|怎样|如何|什么情况|结果)`),
    new RegExp(`(?:你|您)(?:的)?(?:对象|老公|老婆|丈夫|妻子|男朋友|女朋友|男友|女友|伴侣|另一半|家庭|父母)`
        + `[\\s是大概约]*(?:关系|感情|怎么样|怎样|如何|什么情况|谁|哪(?:里|位)|出轨|吵架)`),
    // "收入类的询问：...挣/赚/花多少/大概多少"
    new RegExp(`(?:你|您)(?:一?个?月|每年|大概|大约|现在)?(?:大概|大约)?(?:能)?(?:挣|赚|花|开销|收入|拿)(?:多少|几|[\\s]*(?:k|w|块|元))`),
    // "告诉/说说/分享/透露/聊聊 ... (你/你的) X"
    new RegExp(`(?:告诉|说说|分享|透露|聊聊|聊一下|介绍一下|讲讲)(?:我|我们)?[\\s，,]*`
        + `(?:你|您)(?:的)?(?:工资|月薪|年薪|收入|存款|体检|病历|病情|对象|老公|老婆|伴侣|家庭)`),
];
/**
 * Scan `text`, masking the innermost matched disclosure span for every rule.
 * Rules are applied non-overlapping (a later rule cannot match inside a span
 * an earlier rule already masked). Non-string / corrupt inputs return a no-hit
 * passthrough.
 */
export function scanTopics(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return { categories: [], masked: text, hit: false };
    }
    const hits = [];
    for (const rule of TOPIC_RULES) {
        // Clone with the global flag: without `g`, RegExp#exec never advances
        // lastIndex and the while-loop spins forever (OOM — verified by test).
        const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
        const regex = new RegExp(rule.pattern.source, flags);
        let m;
        while ((m = regex.exec(text)) !== null) {
            hits.push({ category: rule.category, start: m.index, end: m.index + m[0].length });
            if (m.index === regex.lastIndex)
                regex.lastIndex += 1;
        }
    }
    if (hits.length === 0)
        return { categories: [], masked: text, hit: false };
    hits.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));
    const selected = [];
    let lastEnd = -1;
    for (const hit of hits) {
        if (hit.start < lastEnd)
            continue;
        selected.push(hit);
        lastEnd = hit.end;
    }
    const seen = new Set();
    const categories = [];
    let masked = '';
    let cursor = 0;
    for (const hit of selected) {
        masked += text.slice(cursor, hit.start);
        masked += PLACEHOLDER(hit.category);
        cursor = hit.end;
        if (!seen.has(hit.category)) {
            seen.add(hit.category);
            categories.push(hit.category);
        }
    }
    masked += text.slice(cursor);
    return { categories, masked, hit: true };
}
/**
 * Detect whether an assistant message fished for a sensitive disclosure.
 * The inducement rules deliberately match loose "you / your X ... how much"
 * phrasings so a locked session cannot slip through by rewording; normal
 * small-talk about the same nouns in a neutral register ("工资条怎么算")
 * does NOT match because it lacks the asker pose.
 */
export function hasInducement(text) {
    if (typeof text !== 'string' || text.length === 0)
        return false;
    for (const rule of INDUCE_RULES) {
        const flags = rule.flags.includes('g') ? rule.flags : rule.flags + 'g';
        const regex = new RegExp(rule.source, flags);
        if (regex.test(text))
            return true;
    }
    return false;
}
