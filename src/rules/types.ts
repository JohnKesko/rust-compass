export interface RuleSuggestedFix {
	description: string;
	before: string;
	after: string;
}

export interface Rule {
	id: string;
	pattern: string;
	title: string;
	rustTerm: string;
	explanation: string;
	example: string;
	deepExplanation: string;
	confidence: number;
	contexts: string[];
	suggestedFix?: RuleSuggestedFix;
	/** URL to official Rust documentation for this concept */
	officialDoc?: string;
}

export interface RuleFile {
	category: string;
	rules: Rule[];
}

export interface RuleMatch {
	rule: Rule;
	range: {
		start: number;
		end: number;
		line: number;
		character: number;
	};
	matchedText: string;
}

export type ProjectContext = "general" | "parser" | "web" | "cli" | "systems";
