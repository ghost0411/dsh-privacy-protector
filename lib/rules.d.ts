/**
 * Detection rules: same 9 rules as the original privacy_gateway project.
 * Each rule: [type, regex, validator?, groupIndex?]
 * groupIndex: when set, only the captured group is replaced (keyword itself kept).
 */
export interface Rule {
    type: string;
    pattern: RegExp;
    validator?: (value: string) => boolean;
    groupIndex?: number;
}
export declare function luhnValid(value: string): boolean;
export declare function idCnValid(value: string): boolean;
export declare function ipv4Valid(value: string): boolean;
export declare const DEFAULT_RULES: Rule[];
export declare function compileRules(extra?: Rule[]): Rule[];
