import * as vscode from 'vscode';
import { RuleEngine, ProjectContext, Rule } from '../rules';
import { CargoAnalyzerService, DetectedDependencies, PatternTracker } from '../services';

interface AlternativeOption {
    method: string;
    useWhen: string;
}

interface DecisionGuide {
    question: string;
    alternatives: AlternativeOption[];
    thinkAbout?: string;
    rustBookLink?: string;  // Direct link to Rust Book section
    rustBookSection?: string; // Section name for display
    depAware?: (deps: DetectedDependencies) => AlternativeOption[]; // Dependency-aware alternatives
}

export class RustHoverProvider implements vscode.HoverProvider {
    // Event emitter for when a rule is hovered
    private _onRuleHovered = new vscode.EventEmitter<Rule>();
    public readonly onRuleHovered = this._onRuleHovered.event;
    private cargoAnalyzer: CargoAnalyzerService;
    private patternTracker: PatternTracker;

    constructor(
        private ruleEngine: RuleEngine,
        private getContext: () => ProjectContext
    ) {
        this.cargoAnalyzer = CargoAnalyzerService.getInstance();
        this.patternTracker = PatternTracker.getInstance();
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        const match = this.ruleEngine.findMatchAtPosition(
            document,
            position,
            this.getContext()
        );

        if (!match) {
            return null;
        }

        const { rule } = match;

        // Emit event to update the panel automatically
        this._onRuleHovered.fire(rule);

        // Check for loop context synchronously (simple heuristic)
        const inLoop = this.isInsideLoopSync(document, position);

        // Get dependencies for smart hints
        const deps = await this.cargoAnalyzer.getDependencies();

        // Build the decision guide hover
        const content = new vscode.MarkdownString();
        content.isTrusted = true;
        content.supportHtml = true;

        // Header
        content.appendMarkdown(`**🦀 Rust Compass**\n\n`);

        // Get the decision guide for this pattern
        const guide = this.getDecisionGuide(rule.id, inLoop, deps);

        if (guide) {
            // The key question to ask yourself
            content.appendMarkdown(`**${guide.question}**\n\n`);

            // Show alternatives - include dependency-aware ones if available
            let alternatives = [...guide.alternatives];
            if (guide.depAware) {
                alternatives = [...alternatives, ...guide.depAware(deps)];
            }

            for (const alt of alternatives) {
                content.appendMarkdown(`\`${alt.method}\` → ${alt.useWhen}\n\n`);
            }

            // Optional "think about" hint for context
            if (guide.thinkAbout) {
                content.appendMarkdown(`💡 *${guide.thinkAbout}*\n\n`);
            }

            // Action links: Learn more + Rust Book + Ask AI
            const links: string[] = [];

            // Learn more opens a full documentation tab
            const learnMoreArgs = encodeURIComponent(JSON.stringify({ ruleId: rule.id }));
            links.push(`[📚 Learn more](command:rust-compass.learnMore?${learnMoreArgs})`);

            if (guide.rustBookLink) {
                links.push(`[📖 ${guide.rustBookSection || 'Rust Book'}](${guide.rustBookLink})`);
            }

            // Ask AI with context about this specific pattern and code
            const aiPrompt = encodeURIComponent(this.buildAIPrompt(rule, guide, document, position, deps));
            links.push(`[🤖 Ask AI](command:rust-compass.askAI?${encodeURIComponent(JSON.stringify({ prompt: aiPrompt, ruleId: rule.id }))})`);

            content.appendMarkdown(links.join(' · '));

            // Show learning progress insight
            const insight = this.patternTracker.getInsightMessage(rule.id);
            if (insight) {
                content.appendMarkdown(`\n\n---\n*${insight}*`);
            }
        } else {
            // Fallback for rules without decision guides
            content.appendMarkdown(`${rule.explanation}\n\n`);

            // Learn more + Ask AI
            const learnMoreArgs = encodeURIComponent(JSON.stringify({ ruleId: rule.id }));
            content.appendMarkdown(`[📚 Learn more](command:rust-compass.learnMore?${learnMoreArgs}) · `);

            const aiPrompt = encodeURIComponent(`Explain this Rust pattern and when to use it: ${rule.rustTerm}`);
            content.appendMarkdown(`[🤖 Ask AI](command:rust-compass.askAI?${encodeURIComponent(JSON.stringify({ prompt: aiPrompt, ruleId: rule.id }))})`);
        }

        const range = new vscode.Range(
            document.positionAt(match.range.start),
            document.positionAt(match.range.end)
        );

        return new vscode.Hover(content, range);
    }

    dispose() {
        this._onRuleHovered.dispose();
    }

    /**
     * Build a smart AI prompt with context from the actual code
     */
    private buildAIPrompt(rule: Rule, guide: DecisionGuide, document: vscode.TextDocument, position: vscode.Position, deps: DetectedDependencies): string {
        // Get surrounding code for context (5 lines before and after)
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const codeContext = document.getText(new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length)
        ));

        // Build dependency context
        const depContext = this.buildDependencyContext(deps);

        return `I'm learning Rust and working on this code:

\`\`\`rust
${codeContext}
\`\`\`
${depContext}
I'm using \`${rule.rustTerm}\` and wondering: ${guide.question}

The alternatives I know about are:
${guide.alternatives.map(a => `- ${a.method}: ${a.useWhen}`).join('\n')}

Based on my specific code and project setup, which approach would be best and why? Keep the explanation beginner-friendly.`;
    }

    /**
     * Build dependency context string for AI prompt
     */
    private buildDependencyContext(deps: DetectedDependencies): string {
        const parts: string[] = [];

        if (deps.async.length > 0) {
            parts.push(`async runtime: ${deps.async.join(', ')}`);
        }
        if (deps.web.length > 0) {
            parts.push(`web framework: ${deps.web.join(', ')}`);
        }
        if (deps.serialization.length > 0) {
            parts.push(`serialization: ${deps.serialization.join(', ')}`);
        }
        if (deps.error.length > 0) {
            parts.push(`error handling: ${deps.error.join(', ')}`);
        }
        if (deps.parsing.length > 0) {
            parts.push(`parsing: ${deps.parsing.join(', ')}`);
        }

        if (parts.length === 0) {
            return '';
        }

        return `\nMy project uses: ${parts.join(', ')}.\n`;
    }

    /**
     * Get a decision guide - helps you think through which approach to use
     */
    private getDecisionGuide(ruleId: string, inLoop: boolean, deps: DetectedDependencies): DecisionGuide | null {
        const guides: Record<string, DecisionGuide> = {
            'iterator-next-without-peekable': {
                question: 'Do you need to look ahead before deciding?',
                alternatives: [
                    { method: '.next()', useWhen: 'consume and process one by one' },
                    { method: '.peek()', useWhen: 'look ahead without consuming' },
                    { method: '.next_if(|c| ...)', useWhen: 'conditionally consume' },
                ],
                thinkAbout: inLoop
                    ? 'In a loop — if you need lookahead, wrap in .peekable() first'
                    : 'For parsers/lexers, .peekable() is almost always what you want',
                rustBookLink: 'https://doc.rust-lang.org/book/ch13-02-iterators.html',
                rustBookSection: 'Iterators'
            },
            'iter-vs-into-iter': {
                question: 'Do you still need the collection after iterating?',
                alternatives: [
                    { method: '.iter()', useWhen: 'borrow items, keep collection' },
                    { method: '.into_iter()', useWhen: 'consume collection, own items' },
                    { method: '.iter_mut()', useWhen: 'modify items in place' },
                ],
                thinkAbout: 'Default to .iter() — only use .into_iter() when you\'re done with it',
                rustBookLink: 'https://doc.rust-lang.org/book/ch13-02-iterators.html#methods-that-consume-the-iterator',
                rustBookSection: 'Consuming Iterators'
            },
            'collect-turbofish': {
                question: 'What collection type do you need?',
                alternatives: [
                    { method: 'Vec<_>', useWhen: 'ordered list, can have duplicates' },
                    { method: 'HashSet<_>', useWhen: 'unique items, fast lookup' },
                    { method: 'HashMap<K,V>', useWhen: 'key-value pairs' },
                    { method: 'String', useWhen: 'collecting chars into text' },
                ],
                thinkAbout: 'Use type annotation or turbofish: let v: Vec<_> = ... or .collect::<Vec<_>>()',
                rustBookLink: 'https://doc.rust-lang.org/book/ch13-02-iterators.html#methods-that-produce-other-iterators',
                rustBookSection: 'Iterator Adaptors',
                // Add async stream collection if using async
                depAware: (d) => {
                    const extra: AlternativeOption[] = [];
                    if (d.async.length > 0) {
                        extra.push({ method: '.collect::<Result<Vec<_>, _>>()', useWhen: 'collecting fallible async results' });
                    }
                    if (d.serialization.includes('serde')) {
                        extra.push({ method: 'serde_json::Value', useWhen: 'collecting into JSON structure' });
                    }
                    return extra;
                }
            },
            'excessive-clone': {
                question: 'Why are you cloning? Consider alternatives:',
                alternatives: [
                    { method: '&T', useWhen: 'you only need to read the data' },
                    { method: 'Cow<T>', useWhen: 'clone only when you need to mutate' },
                    { method: '.clone()', useWhen: 'you truly need an independent copy' },
                ],
                thinkAbout: 'Cloning is fine for prototyping, but think about ownership flow',
                rustBookLink: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
                rustBookSection: 'Ownership'
            },
            'string-vs-str': {
                question: 'Who owns this string data?',
                alternatives: [
                    { method: '&str', useWhen: 'borrowing, function params, literals' },
                    { method: 'String', useWhen: 'owned, need to modify, store in struct' },
                    { method: 'Cow<str>', useWhen: 'might be borrowed or owned' },
                ],
                thinkAbout: 'Prefer &str in function signatures — caller decides ownership',
                rustBookLink: 'https://doc.rust-lang.org/book/ch04-03-slices.html#string-slices',
                rustBookSection: 'String Slices'
            },
            'unwrap-usage': {
                question: 'What should happen if this is None/Err?',
                alternatives: [
                    { method: '?', useWhen: 'propagate error to caller' },
                    { method: '.expect("why")', useWhen: 'panic with explanation' },
                    { method: 'match/if let', useWhen: 'handle the error case' },
                    { method: '.unwrap_or(default)', useWhen: 'use fallback value' },
                ],
                thinkAbout: '.unwrap() is fine in tests and prototypes, but think about errors',
                rustBookLink: 'https://doc.rust-lang.org/book/ch09-02-recoverable-errors-with-result.html',
                rustBookSection: 'Error Handling',
                // Add anyhow/thiserror suggestions if those crates are present
                depAware: (d) => {
                    const extra: AlternativeOption[] = [];
                    if (d.error.includes('anyhow')) {
                        extra.push({ method: 'anyhow::Result', useWhen: 'easy error propagation with context' });
                        extra.push({ method: '.context("msg")', useWhen: 'add context to errors (anyhow)' });
                    }
                    if (d.error.includes('thiserror')) {
                        extra.push({ method: '#[derive(Error)]', useWhen: 'define custom error types' });
                    }
                    if (d.error.includes('eyre') || d.error.includes('color-eyre')) {
                        extra.push({ method: 'eyre::Result', useWhen: 'rich error reports with color-eyre' });
                    }
                    return extra;
                }
            },
            'expect-usage': {
                question: 'Is this truly an impossible case?',
                alternatives: [
                    { method: '.expect("reason")', useWhen: 'panic should "never" happen' },
                    { method: '?', useWhen: 'caller should handle the error' },
                    { method: '.unwrap_or_else(|| ...)', useWhen: 'compute fallback lazily' },
                ],
                thinkAbout: 'Good for invariants — document WHY it should never fail',
                rustBookLink: 'https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html',
                rustBookSection: 'To Panic or Not'
            },
            'lexer-peekable-chars': {
                question: 'Building a lexer? Key iterator tools:',
                alternatives: [
                    { method: '.peekable()', useWhen: 'look ahead at next char' },
                    { method: '.take_while()', useWhen: 'consume while condition true' },
                    { method: '.by_ref()', useWhen: 'borrow iterator temporarily' },
                ],
                thinkAbout: 'Lexers need lookahead — wrap .chars() in .peekable() early',
                rustBookLink: 'https://doc.rust-lang.org/book/ch13-02-iterators.html',
                rustBookSection: 'Iterators',
                // Add parsing library suggestions if present
                depAware: (d) => {
                    const extra: AlternativeOption[] = [];
                    if (d.parsing.includes('nom')) {
                        extra.push({ method: 'nom combinators', useWhen: 'you have nom — use its parser combinators instead' });
                    }
                    if (d.parsing.includes('pest')) {
                        extra.push({ method: 'pest grammar', useWhen: 'you have pest — define grammar in .pest file' });
                    }
                    if (d.parsing.includes('logos')) {
                        extra.push({ method: '#[derive(Logos)]', useWhen: 'you have logos — use derive macro for lexer' });
                    }
                    if (d.parsing.includes('chumsky')) {
                        extra.push({ method: 'chumsky parsers', useWhen: 'you have chumsky — use its combinator API' });
                    }
                    return extra;
                }
            },
            'match-exhaustive': {
                question: 'Have you handled all cases?',
                alternatives: [
                    { method: 'explicit arms', useWhen: 'handle each variant differently' },
                    { method: '_ =>', useWhen: 'catch-all for remaining cases' },
                    { method: '.. in pattern', useWhen: 'ignore some struct fields' },
                ],
                thinkAbout: 'Exhaustive matching catches bugs when you add new variants',
                rustBookLink: 'https://doc.rust-lang.org/book/ch06-02-match.html',
                rustBookSection: 'Match Control Flow'
            },
            'state-machine-enum': {
                question: 'Modeling state? Enums are your friend:',
                alternatives: [
                    { method: 'enum State { ... }', useWhen: 'each state has different data' },
                    { method: 'match state', useWhen: 'handle each state explicitly' },
                    { method: 'State::transition()', useWhen: 'encapsulate valid transitions' },
                ],
                thinkAbout: 'Enums + match = compiler-checked state machines',
                rustBookLink: 'https://doc.rust-lang.org/book/ch06-01-defining-an-enum.html',
                rustBookSection: 'Enums'
            },
        };

        return guides[ruleId] || null;
    }

    /**
     * Simple synchronous loop detection using text analysis
     */
    private isInsideLoopSync(document: vscode.TextDocument, position: vscode.Position): boolean {
        const startLine = Math.max(0, position.line - 20);
        const text = document.getText(new vscode.Range(
            new vscode.Position(startLine, 0),
            position
        ));

        // Count loop openings vs closings
        const loopMatches = text.match(/\b(for|while|loop)\b[^{]*\{/g) || [];
        const openBraces = (text.match(/\{/g) || []).length;
        const closeBraces = (text.match(/\}/g) || []).length;

        // Simple heuristic: if there's a loop and more opens than closes
        return loopMatches.length > 0 && openBraces > closeBraces;
    }
}
