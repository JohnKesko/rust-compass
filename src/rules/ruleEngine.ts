import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Rule, RuleFile, RuleMatch, ProjectContext } from './types';

export class RuleEngine {
    private rules: Rule[] = [];
    private compiledPatterns: Map<string, RegExp> = new Map();

    // Cache matches per document version to avoid re-scanning
    private matchCache: Map<string, { version: number; context: ProjectContext; matches: RuleMatch[] }> = new Map();

    constructor(private extensionPath: string) {
        this.loadRules();
    }

    private loadRules(): void {
        const rulesDir = path.join(this.extensionPath, 'rules');

        if (!fs.existsSync(rulesDir)) {
            console.warn('Rules directory not found:', rulesDir);
            return;
        }

        const files = fs.readdirSync(rulesDir).filter(f => f.endsWith('.json'));

        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(rulesDir, file), 'utf-8');
                const ruleFile: RuleFile = JSON.parse(content);
                this.rules.push(...ruleFile.rules);

                // Pre-compile patterns
                for (const rule of ruleFile.rules) {
                    try {
                        this.compiledPatterns.set(rule.id, new RegExp(rule.pattern, 'g'));
                    } catch (e) {
                        console.error(`Invalid pattern in rule ${rule.id}:`, e);
                    }
                }

                console.log(`Loaded ${ruleFile.rules.length} rules from ${file}`);
            } catch (e) {
                console.error(`Error loading rule file ${file}:`, e);
            }
        }

        console.log(`Total rules loaded: ${this.rules.length}`);
    }

    public findMatches(document: vscode.TextDocument, context: ProjectContext): RuleMatch[] {
        // Check cache first
        const cacheKey = document.uri.toString();
        const cached = this.matchCache.get(cacheKey);
        if (cached && cached.version === document.version && cached.context === context) {
            return cached.matches;
        }

        const matches: RuleMatch[] = [];
        const text = document.getText();

        for (const rule of this.rules) {
            // Filter by context
            if (!rule.contexts.includes(context) && !rule.contexts.includes('general')) {
                continue;
            }

            const pattern = this.compiledPatterns.get(rule.id);
            if (!pattern) { continue; }

            // Reset regex state
            pattern.lastIndex = 0;

            let match;
            while ((match = pattern.exec(text)) !== null) {
                const pos = document.positionAt(match.index);
                matches.push({
                    rule,
                    range: {
                        start: match.index,
                        end: match.index + match[0].length,
                        line: pos.line,
                        character: pos.character
                    },
                    matchedText: match[0]
                });
            }
        }

        // Cache the results
        this.matchCache.set(cacheKey, { version: document.version, context, matches });

        // Limit cache size (keep last 10 documents)
        if (this.matchCache.size > 10) {
            const firstKey = this.matchCache.keys().next().value;
            if (firstKey) { this.matchCache.delete(firstKey); }
        }

        return matches;
    }

    public findMatchAtPosition(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: ProjectContext
    ): RuleMatch | undefined {
        const matches = this.findMatches(document, context);
        const offset = document.offsetAt(position);

        return matches.find(m => offset >= m.range.start && offset <= m.range.end);
    }

    public getRuleById(id: string): Rule | undefined {
        return this.rules.find(r => r.id === id);
    }

    public getAllRules(): Rule[] {
        return [...this.rules];
    }

    public reloadRules(): void {
        this.rules = [];
        this.compiledPatterns.clear();
        this.matchCache.clear();
        this.loadRules();
    }
}
