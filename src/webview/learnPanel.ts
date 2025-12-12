import * as vscode from 'vscode';
import { Rule } from '../rules';
import { rustDocsFetcher, RustDocsFetcher, FetchedDocContent, explanationSimplifier, SimplifiedExplanation } from '../services';

/**
 * A full-page webview panel for learning content
 * Opens as an editor tab, not a sidebar
 */
export class LearnPanel {
    public static currentPanel: LearnPanel | undefined;
    private static readonly viewType = 'rustCompass.learnPanel';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _currentRule: Rule | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set initial content
        this._panel.webview.html = this._getLoadingHtml();

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );

        // Handle disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    /**
     * Handle messages from the webview
     */
    private async _handleMessage(message: { command: string; url?: string; term?: string }) {
        switch (message.command) {
            case 'fetchOfficialDoc':
                await this._fetchAndUpdateOfficialDoc(message.url, message.term);
                break;
            case 'openExternal':
                if (message.url) {
                    vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;
        }
    }

    /**
     * Fetch official documentation and update the panel
     */
    private async _fetchAndUpdateOfficialDoc(url?: string, term?: string) {
        // Try to determine URL
        let docUrl = url;
        if (!docUrl && term) {
            docUrl = RustDocsFetcher.buildDocUrl(term) || undefined;
        }
        if (!docUrl && this._currentRule?.officialDoc) {
            docUrl = this._currentRule.officialDoc;
        }
        if (!docUrl && this._currentRule?.rustTerm) {
            // Try to build URL from rustTerm
            const cleanTerm = this._currentRule.rustTerm.replace(/[():]/g, '').split('::').pop() || '';
            docUrl = RustDocsFetcher.buildDocUrl(cleanTerm) || undefined;
        }

        if (!docUrl) {
            this._panel.webview.postMessage({
                command: 'officialDocResult',
                success: false,
                error: 'Could not determine documentation URL'
            });
            return;
        }

        try {
            const content = await rustDocsFetcher.fetchDoc(docUrl);
            this._panel.webview.postMessage({
                command: 'officialDocResult',
                success: !!content,
                content,
                url: docUrl
            });
        } catch {
            this._panel.webview.postMessage({
                command: 'officialDocResult',
                success: false,
                error: 'Failed to fetch documentation',
                url: docUrl
            });
        }
    }

    /**
     * Create or show the learn panel with content for a specific rule
     */
    public static show(extensionUri: vscode.Uri, rule: Rule) {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it
        if (LearnPanel.currentPanel) {
            LearnPanel.currentPanel._panel.reveal(column);
            LearnPanel.currentPanel._update(rule);
            return;
        }

        // Create a new panel
        const panel = vscode.window.createWebviewPanel(
            LearnPanel.viewType,
            `🦀 ${rule.title}`,
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        LearnPanel.currentPanel = new LearnPanel(panel, extensionUri);
        LearnPanel.currentPanel._update(rule);
    }

    /**
     * Show error help content
     */
    public static showError(extensionUri: vscode.Uri, errorCode: string, errorMessage: string, rules: Rule[]) {
        const column = vscode.ViewColumn.Beside;

        if (LearnPanel.currentPanel) {
            LearnPanel.currentPanel._panel.reveal(column);
            LearnPanel.currentPanel._updateError(errorCode, errorMessage, rules);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            LearnPanel.viewType,
            `🔴 ${errorCode || 'Compiler Error'}`,
            column,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        LearnPanel.currentPanel = new LearnPanel(panel, extensionUri);
        LearnPanel.currentPanel._updateError(errorCode, errorMessage, rules);
    }

    private async _update(rule: Rule) {
        this._currentRule = rule;
        this._panel.title = `🦀 ${rule.title}`;

        // Show loading state immediately
        this._panel.webview.html = this._getLoadingPageHtml(rule);

        // Fetch official docs
        const docUrl = rule.officialDoc || RustDocsFetcher.buildDocUrl(
            rule.rustTerm.replace(/[():]/g, '').split('::').pop() || ''
        );

        let fetchedDoc: FetchedDocContent | null = null;
        if (docUrl) {
            try {
                fetchedDoc = await rustDocsFetcher.fetchDoc(docUrl);
            } catch (e) {
                console.error('Failed to fetch docs:', e);
            }
        }

        // Try to simplify for beginners using LLM (if available)
        let simplified: SimplifiedExplanation | null = null;
        if (fetchedDoc?.description) {
            try {
                simplified = await explanationSimplifier.simplify(
                    rule.rustTerm,
                    fetchedDoc.description,
                    rule.title
                );
            } catch (e) {
                console.error('Failed to simplify explanation:', e);
            }
        }

        // Render with fetched content (or fallback)
        this._panel.webview.html = this._getDocBasedHtml(rule, fetchedDoc, docUrl || undefined, simplified);
    }

    /**
     * Loading page shown while fetching docs
     */
    private _getLoadingPageHtml(rule: Rule): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${this._escapeHtml(rule.title)}</title>
            ${this._getStyles()}
        </head>
        <body>
            <div class="container">
                <header>
                    <h1>${this._escapeHtml(rule.title)}</h1>
                    <span class="rust-term">${this._escapeHtml(rule.rustTerm)}</span>
                </header>
                
                <section class="loading-section">
                    <div class="loading-indicator">
                        <span class="spinner"></span>
                        <span>Fetching from docs.rust-lang.org...</span>
                    </div>
                </section>
            </div>
        </body>
        </html>`;
    }

    /**
     * Main content page based on fetched official documentation
     */
    private _getDocBasedHtml(rule: Rule, doc: FetchedDocContent | null, docUrl?: string, simplified?: SimplifiedExplanation | null): string {
        const alternatives = this._getAlternatives(rule.id);

        // Use simplified explanation if available, otherwise fall back to rule.explanation
        const beginnerExplanation = simplified?.simple || rule.explanation;

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${this._escapeHtml(rule.title)}</title>
            ${this._getStyles()}
        </head>
        <body>
            <div class="container">
                <header>
                    <h1>${this._escapeHtml(rule.title)}</h1>
                    <code class="rust-term">${this._escapeHtml(rule.rustTerm)}</code>
                </header>

                <div class="level-tabs">
                    <button class="level-tab active" data-level="beginner">Beginner</button>
                    <button class="level-tab" data-level="intermediate">Official Docs</button>
                </div>

                <!-- BEGINNER: Simple overview + all alternatives -->
                <div class="level-content beginner-content active">
                    <section class="simple-explanation">
                        <p class="lead">${this._escapeHtml(beginnerExplanation)}</p>
                        
                        ${simplified?.keyPoints && simplified.keyPoints.length > 0 ? `
                        <ul class="key-points">
                            ${simplified.keyPoints.map(point => `<li>${this._escapeHtml(point)}</li>`).join('')}
                        </ul>
                        ` : ''}
                        
                        ${simplified?.gotchas && simplified.gotchas.length > 0 ? `
                        <div class="gotchas">
                            <strong>Watch out:</strong>
                            <ul>
                                ${simplified.gotchas.map(gotcha => `<li>${this._escapeHtml(gotcha)}</li>`).join('')}
                            </ul>
                        </div>
                        ` : ''}
                    </section>
                    
                    <section class="simple-example">
                        <h3>Example</h3>
                        <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
                    </section>
                    
                    ${alternatives ? `
                    <section class="alternatives">
                        <h3>Other Options</h3>
                        <table class="alternatives-table">
                            <thead>
                                <tr>
                                    <th>Code</th>
                                    <th>What it does</th>
                                    <th>Use when</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${alternatives.options.map(opt => `
                                <tr class="${opt.current ? 'current-row' : ''} ${opt.recommended ? 'recommended-row' : ''}">
                                    <td>
                                        <code>${opt.code}</code>
                                        ${opt.current ? '<span class="tag">current</span>' : ''}
                                        ${opt.recommended ? '<span class="tag recommended">recommended</span>' : ''}
                                    </td>
                                    <td>${opt.description}</td>
                                    <td>${opt.useWhen}</td>
                                </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </section>
                    ` : ''}
                    
                    ${docUrl ? `
                    <p class="go-deeper">
                        <a href="#" class="switch-tab-link" data-target="intermediate">Read official documentation →</a>
                    </p>
                    ` : ''}
                </div>

                <!-- INTERMEDIATE: Official docs content -->
                <div class="level-content intermediate-content">
                    ${doc ? this._renderOfficialDoc(doc, docUrl) : this._renderFallback(rule, docUrl)}
                </div>
            </div>
            
            <script>
                const vscode = acquireVsCodeApi();
                
                // Tab switching
                const tabs = document.querySelectorAll('.level-tab');
                const contents = document.querySelectorAll('.level-content');
                
                function switchTab(level) {
                    tabs.forEach(t => t.classList.remove('active'));
                    document.querySelector('[data-level="' + level + '"]')?.classList.add('active');
                    
                    contents.forEach(c => {
                        c.classList.remove('active');
                        if (c.classList.contains(level + '-content')) {
                            c.classList.add('active');
                        }
                    });
                }

                tabs.forEach(tab => {
                    tab.addEventListener('click', () => switchTab(tab.dataset.level));
                });
                
                // "Read official docs" link
                document.querySelectorAll('.switch-tab-link').forEach(link => {
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        switchTab(e.target.dataset.target);
                    });
                });
                
                // External links
                document.querySelectorAll('.external-link').forEach(link => {
                    link.addEventListener('click', (e) => {
                        e.preventDefault();
                        vscode.postMessage({ command: 'openExternal', url: e.target.closest('a').href });
                    });
                });
            </script>
        </body>
        </html>`;
    }

    /**
     * Get all alternative methods/approaches for a topic
     * This shows beginners the FULL picture of available options
     */
    private _getAlternatives(ruleId: string): {
        title: string;
        intro: string;
        options: Array<{
            code: string;
            description: string;
            useWhen: string;
            current?: boolean;
            recommended?: boolean;
            docUrl?: string;
        }>;
    } | null {
        const alternatives: Record<string, ReturnType<typeof this._getAlternatives>> = {
            // Iterator consumption methods
            'iterator-next-without-peekable': {
                title: 'All Iterator Methods',
                intro: 'When iterating, you have several options depending on whether you need to look ahead, consume items, or both:',
                options: [
                    {
                        code: '.next()',
                        description: 'Get and remove the next item',
                        useWhen: 'You want to consume items one by one',
                        current: true,
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#tymethod.next'
                    },
                    {
                        code: '.peek()',
                        description: 'Look at next item without removing it',
                        useWhen: 'You need to see what\'s next before deciding',
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/iter/struct.Peekable.html#method.peek'
                    },
                    {
                        code: '.peekable()',
                        description: 'Convert iterator to support peeking',
                        useWhen: 'You need lookahead capability',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.peekable'
                    },
                    {
                        code: '.take(n)',
                        description: 'Get only first n items',
                        useWhen: 'You only need a limited number',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.take'
                    },
                    {
                        code: '.skip(n)',
                        description: 'Skip first n items',
                        useWhen: 'You want to start from a later position',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.skip'
                    },
                    {
                        code: '.nth(n)',
                        description: 'Get item at position n',
                        useWhen: 'You need a specific position',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.nth'
                    }
                ]
            },

            // iter vs into_iter
            'iter-vs-into-iter': {
                title: 'Ways to Iterate',
                intro: 'Choose how you want to access items - borrow them, modify them, or take ownership:',
                options: [
                    {
                        code: '.iter()',
                        description: 'Borrow items (&T)',
                        useWhen: 'You want to read items, keep the collection',
                        current: true,
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.IntoIterator.html'
                    },
                    {
                        code: '.iter_mut()',
                        description: 'Mutably borrow items (&mut T)',
                        useWhen: 'You need to modify items in place',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.IntoIterator.html'
                    },
                    {
                        code: '.into_iter()',
                        description: 'Take ownership (T)',
                        useWhen: 'You\'re done with the collection, want to transform it',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.IntoIterator.html'
                    },
                    {
                        code: 'for x in &items',
                        description: 'Same as .iter()',
                        useWhen: 'Cleaner syntax for borrowing',
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/keyword.for.html'
                    },
                    {
                        code: 'for x in &mut items',
                        description: 'Same as .iter_mut()',
                        useWhen: 'Cleaner syntax for mutable access',
                        docUrl: 'https://doc.rust-lang.org/std/keyword.for.html'
                    }
                ]
            },

            // for_each vs for loop
            'for-each-vs-for': {
                title: 'Looping Options',
                intro: 'Different ways to process each item in a collection:',
                options: [
                    {
                        code: 'for x in items',
                        description: 'Standard for loop',
                        useWhen: 'Most cases - clear, supports break/continue',
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/keyword.for.html'
                    },
                    {
                        code: '.for_each(|x| ...)',
                        description: 'Closure on each item',
                        useWhen: 'End of iterator chains, no break needed',
                        current: true,
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.for_each'
                    },
                    {
                        code: 'while let Some(x) = iter.next()',
                        description: 'Manual iteration',
                        useWhen: 'You need fine control over iteration',
                        docUrl: 'https://doc.rust-lang.org/std/keyword.while.html'
                    },
                    {
                        code: 'loop { }',
                        description: 'Infinite loop with break',
                        useWhen: 'Complex control flow, return values from loop',
                        docUrl: 'https://doc.rust-lang.org/std/keyword.loop.html'
                    },
                    {
                        code: '.try_for_each(|x| ...)',
                        description: 'for_each with early exit',
                        useWhen: 'You need to stop early on error/condition',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.try_for_each'
                    }
                ]
            },

            // unwrap alternatives
            'unwrap-usage': {
                title: 'Handling Option/Result',
                intro: 'Many ways to handle values that might be missing or errors:',
                options: [
                    {
                        code: '.unwrap()',
                        description: 'Panic if None/Err',
                        useWhen: 'Tests, prototypes, impossible cases',
                        current: true,
                        docUrl: 'https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap'
                    },
                    {
                        code: '?',
                        description: 'Propagate error up',
                        useWhen: 'Let caller handle the error',
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/result/index.html#the-question-mark-operator-'
                    },
                    {
                        code: '.expect("msg")',
                        description: 'Panic with custom message',
                        useWhen: 'Documenting why it should never fail',
                        docUrl: 'https://doc.rust-lang.org/std/option/enum.Option.html#method.expect'
                    },
                    {
                        code: '.unwrap_or(default)',
                        description: 'Use default if None/Err',
                        useWhen: 'You have a sensible fallback value',
                        docUrl: 'https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap_or'
                    },
                    {
                        code: '.unwrap_or_default()',
                        description: 'Use Default::default()',
                        useWhen: 'Type has a Default impl',
                        docUrl: 'https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap_or_default'
                    },
                    {
                        code: 'match / if let',
                        description: 'Handle each case explicitly',
                        useWhen: 'You need different logic for each case',
                        docUrl: 'https://doc.rust-lang.org/std/keyword.match.html'
                    },
                    {
                        code: '.ok_or(err)',
                        description: 'Convert Option to Result',
                        useWhen: 'You want to use ? with Option',
                        docUrl: 'https://doc.rust-lang.org/std/option/enum.Option.html#method.ok_or'
                    }
                ]
            },

            // map/filter/fold
            'map-filter-fold': {
                title: 'Iterator Transformations',
                intro: 'Transform and combine items in different ways:',
                options: [
                    {
                        code: '.map(|x| ...)',
                        description: 'Transform each item',
                        useWhen: 'Convert items to new values',
                        current: true,
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.map'
                    },
                    {
                        code: '.filter(|x| ...)',
                        description: 'Keep only matching items',
                        useWhen: 'Remove items that don\'t match',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.filter'
                    },
                    {
                        code: '.filter_map(|x| ...)',
                        description: 'Filter and transform in one',
                        useWhen: 'Transform returns Option, skip None',
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.filter_map'
                    },
                    {
                        code: '.fold(init, |acc, x| ...)',
                        description: 'Reduce to single value',
                        useWhen: 'Combine all items into one result',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.fold'
                    },
                    {
                        code: '.reduce(|acc, x| ...)',
                        description: 'Fold without initial value',
                        useWhen: 'First item is the initial accumulator',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.reduce'
                    },
                    {
                        code: '.flat_map(|x| ...)',
                        description: 'Map then flatten',
                        useWhen: 'Each item maps to multiple items',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.flat_map'
                    },
                    {
                        code: '.collect()',
                        description: 'Gather into collection',
                        useWhen: 'Build Vec, HashMap, String, etc.',
                        docUrl: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.collect'
                    }
                ]
            },

            // collect
            'collect-turbofish': {
                title: 'Collecting Into Types',
                intro: 'collect() can create many different collection types:',
                options: [
                    {
                        code: '.collect::<Vec<_>>()',
                        description: 'Into a vector',
                        useWhen: 'You need an ordered, growable list',
                        current: true,
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/vec/struct.Vec.html'
                    },
                    {
                        code: '.collect::<HashSet<_>>()',
                        description: 'Into a hash set',
                        useWhen: 'You need unique values, fast lookup',
                        docUrl: 'https://doc.rust-lang.org/std/collections/struct.HashSet.html'
                    },
                    {
                        code: '.collect::<HashMap<_, _>>()',
                        description: 'Into a hash map',
                        useWhen: 'From iterator of (key, value) tuples',
                        docUrl: 'https://doc.rust-lang.org/std/collections/struct.HashMap.html'
                    },
                    {
                        code: '.collect::<String>()',
                        description: 'Into a string',
                        useWhen: 'From iterator of chars or &str',
                        docUrl: 'https://doc.rust-lang.org/std/string/struct.String.html'
                    },
                    {
                        code: '.collect::<Result<Vec<_>, _>>()',
                        description: 'Collect with error handling',
                        useWhen: 'Each item might fail, stop on first error',
                        docUrl: 'https://doc.rust-lang.org/std/result/enum.Result.html#impl-FromIterator%3CResult%3CA,+E%3E%3E-for-Result%3CV,+E%3E'
                    },
                    {
                        code: '.collect::<Option<Vec<_>>>()',
                        description: 'Collect Options',
                        useWhen: 'Each item might be None, get None if any None',
                        docUrl: 'https://doc.rust-lang.org/std/option/enum.Option.html#impl-FromIterator%3COption%3CA%3E%3E-for-Option%3CV%3E'
                    }
                ]
            },

            // String vs str
            'string-vs-str': {
                title: 'String Types',
                intro: 'Rust has multiple string types for different needs:',
                options: [
                    {
                        code: '&str',
                        description: 'String slice (borrowed)',
                        useWhen: 'Reading strings, function parameters',
                        current: true,
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/primitive.str.html'
                    },
                    {
                        code: 'String',
                        description: 'Owned, growable string',
                        useWhen: 'Building strings, storing in structs',
                        docUrl: 'https://doc.rust-lang.org/std/string/struct.String.html'
                    },
                    {
                        code: '&String',
                        description: 'Reference to owned string',
                        useWhen: 'Rarely needed - use &str instead',
                        docUrl: 'https://doc.rust-lang.org/std/string/struct.String.html'
                    },
                    {
                        code: 'Cow<str>',
                        description: 'Clone-on-write string',
                        useWhen: 'Might need to modify borrowed data',
                        docUrl: 'https://doc.rust-lang.org/std/borrow/enum.Cow.html'
                    },
                    {
                        code: 'Box<str>',
                        description: 'Owned slice on heap',
                        useWhen: 'Fixed-size string, saving memory',
                        docUrl: 'https://doc.rust-lang.org/std/boxed/struct.Box.html'
                    }
                ]
            },

            // Match patterns
            'match-exhaustive': {
                title: 'Pattern Matching Options',
                intro: 'Different ways to match and destructure values:',
                options: [
                    {
                        code: 'match value { }',
                        description: 'Full pattern matching',
                        useWhen: 'Multiple cases, complex patterns',
                        current: true,
                        docUrl: 'https://doc.rust-lang.org/std/keyword.match.html'
                    },
                    {
                        code: 'if let Some(x) = opt',
                        description: 'Match single pattern',
                        useWhen: 'You only care about one case',
                        recommended: true,
                        docUrl: 'https://doc.rust-lang.org/std/keyword.if.html'
                    },
                    {
                        code: 'let else',
                        description: 'Match or diverge',
                        useWhen: 'Must match, otherwise return/break',
                        docUrl: 'https://doc.rust-lang.org/std/keyword.let.html'
                    },
                    {
                        code: 'while let',
                        description: 'Loop while pattern matches',
                        useWhen: 'Process until pattern fails',
                        docUrl: 'https://doc.rust-lang.org/std/keyword.while.html'
                    },
                    {
                        code: 'matches!(val, pat)',
                        description: 'Check if pattern matches',
                        useWhen: 'Just need true/false',
                        docUrl: 'https://doc.rust-lang.org/std/macro.matches.html'
                    }
                ]
            }
        };

        return alternatives[ruleId] || null;
    }

    /**
     * Render content from official documentation
     */
    private _renderOfficialDoc(doc: FetchedDocContent, docUrl?: string): string {
        let html = '';

        // Official description - THE main content
        html += `
        <section class="official-content">
            <div class="source-badge">📖 From Official Rust Documentation</div>
            <blockquote class="official-description">
                ${this._escapeHtml(doc.description)}
            </blockquote>
            ${docUrl ? `<a href="${docUrl}" class="external-link read-more">Read full documentation →</a>` : ''}
        </section>`;

        // Signature if available
        if (doc.signature) {
            html += `
            <section class="signature-section">
                <h2>Signature</h2>
                <pre class="signature"><code>${this._escapeHtml(doc.signature)}</code></pre>
            </section>`;
        }

        // Examples from official docs
        if (doc.examples && doc.examples.length > 0) {
            html += `
            <section class="examples-section">
                <h2>Examples from Official Docs</h2>
                ${doc.examples.map(ex => `
                    <pre><code class="language-rust">${this._escapeHtml(ex)}</code></pre>
                `).join('')}
            </section>`;
        }

        // Related links
        html += this._getRelatedLinks(docUrl);

        return html;
    }

    /**
     * Fallback when official docs couldn't be fetched
     */
    private _renderFallback(rule: Rule, docUrl?: string): string {
        return `
        <section class="fallback-content">
            <div class="warning-badge">⚠️ Could not fetch official documentation</div>
            
            <h2>Quick Summary</h2>
            <p class="lead">${this._escapeHtml(rule.explanation)}</p>
            
            <h2>Example</h2>
            <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
            
            ${docUrl ? `
            <div class="manual-link">
                <p>View the official documentation directly:</p>
                <a href="${docUrl}" class="external-link doc-button">📖 Open docs.rust-lang.org →</a>
            </div>
            ` : ''}
        </section>`;
    }

    /**
     * Get related documentation links
     */
    private _getRelatedLinks(currentUrl?: string): string {
        if (!currentUrl) return '';

        // Determine related topics based on URL
        const relatedLinks: Array<{ title: string; url: string }> = [];

        if (currentUrl.includes('Iterator')) {
            relatedLinks.push(
                { title: 'Iterator trait', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html' },
                { title: 'The Rust Book: Iterators', url: 'https://doc.rust-lang.org/book/ch13-02-iterators.html' }
            );
        }
        if (currentUrl.includes('Option') || currentUrl.includes('Result')) {
            relatedLinks.push(
                { title: 'Option enum', url: 'https://doc.rust-lang.org/std/option/enum.Option.html' },
                { title: 'Result enum', url: 'https://doc.rust-lang.org/std/result/enum.Result.html' },
                { title: 'The Rust Book: Error Handling', url: 'https://doc.rust-lang.org/book/ch09-00-error-handling.html' }
            );
        }
        if (currentUrl.includes('String') || currentUrl.includes('str')) {
            relatedLinks.push(
                { title: 'String type', url: 'https://doc.rust-lang.org/std/string/struct.String.html' },
                { title: 'str primitive', url: 'https://doc.rust-lang.org/std/primitive.str.html' },
                { title: 'The Rust Book: Strings', url: 'https://doc.rust-lang.org/book/ch08-02-strings.html' }
            );
        }

        // Filter out current URL
        const filtered = relatedLinks.filter(l => l.url !== currentUrl);

        if (filtered.length === 0) return '';

        return `
        <section class="related-section">
            <h2>Related Documentation</h2>
            <ul class="related-links">
                ${filtered.map(link => `
                    <li><a href="${link.url}" class="external-link">${link.title}</a></li>
                `).join('')}
            </ul>
        </section>`;
    }

    private _updateError(errorCode: string, errorMessage: string, rules: Rule[]) {
        this._panel.title = `🔴 ${errorCode || 'Error Help'}`;
        this._panel.webview.html = this._getErrorHtml(errorCode, errorMessage, rules);
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
        <html><body><p>Loading...</p></body></html>`;
    }

    private _getRuleHtml(rule: Rule): string {
        const scenario = this._getRealWorldScenario(rule.id);
        const thinkLikeRust = this._getThinkLikeRust(rule.id);
        const decisionTree = this._getDecisionTree(rule.id);
        const beginnerExplain = this._getBeginnerExplanation(rule.id);

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${this._escapeHtml(rule.title)}</title>
            ${this._getStyles()}
        </head>
        <body>
            <div class="container">
                <header>
                    <h1>${this._escapeHtml(rule.title)}</h1>
                    <span class="rust-term">${this._escapeHtml(rule.rustTerm)}</span>
                </header>

                <div class="level-tabs">
                    <button class="level-tab active" data-level="beginner">Beginner</button>
                    <button class="level-tab" data-level="intermediate">Intermediate</button>
                </div>

                <!-- BEGINNER CONTENT -->
                <div class="level-content beginner-content active">
                    ${beginnerExplain ? `
                    <section class="eli5">
                        <h2>In Plain English</h2>
                        <p class="lead">${beginnerExplain.simple}</p>
                        ${beginnerExplain.analogy ? `
                        <div class="analogy">
                            <h4>Think of it like this:</h4>
                            <p>${beginnerExplain.analogy}</p>
                        </div>
                        ` : ''}
                    </section>

                    <section class="beginner-example">
                        <h2>Simple Example</h2>
                        <div class="before-after">
                            <div class="before">
                                <h4>You might write this...</h4>
                                <pre><code class="language-rust">${this._escapeHtml(beginnerExplain.wrongCode)}</code></pre>
                                <p class="explanation">${beginnerExplain.wrongExplain}</p>
                            </div>
                            <div class="after">
                                <h4>But in Rust, write this:</h4>
                                <pre><code class="language-rust">${this._escapeHtml(beginnerExplain.rightCode)}</code></pre>
                                <p class="explanation">${beginnerExplain.rightExplain}</p>
                            </div>
                        </div>
                    </section>

                    <section class="quick-rules">
                        <h2>Quick Rules</h2>
                        <ul class="rules-list">
                            ${beginnerExplain.quickRules.map(r => `<li>${r}</li>`).join('')}
                        </ul>
                    </section>

                    <section class="common-mistakes">
                        <h2>Common Mistakes</h2>
                        <ul class="mistakes-list">
                            ${beginnerExplain.mistakes.map(m => `
                                <li>
                                    <span class="mistake-wrong">${m.wrong}</span>
                                    <span class="mistake-right">${m.right}</span>
                                </li>
                            `).join('')}
                        </ul>
                    </section>
                    ` : `
                    <section class="eli5">
                        <h2>In Plain English</h2>
                        <p class="lead">${this._escapeHtml(rule.explanation)}</p>
                    </section>

                    <section class="quick-example">
                        <h2>Example</h2>
                        <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
                    </section>
                    `}
                </div>

                <!-- INTERMEDIATE CONTENT -->
                <div class="level-content intermediate-content">
                    ${scenario ? `
                    <section class="scenario">
                        <h2>What You're Probably Trying To Do</h2>
                        <p class="lead">${scenario.task}</p>
                        <div class="scenario-example">
                            <p class="scenario-context">${scenario.context}</p>
                        </div>
                    </section>
                    ` : ''}

                    ${thinkLikeRust ? `
                    <section class="think-rust">
                        <h2>Think Like Rust</h2>
                        <p class="lead">${thinkLikeRust.mindset}</p>
                        <div class="rust-way">
                            <div class="wrong-way">
                                <h4>Coming from other languages</h4>
                                <p>${thinkLikeRust.otherLangs}</p>
                            </div>
                            <div class="right-way">
                                <h4>The Rust way</h4>
                                <p>${thinkLikeRust.rustWay}</p>
                            </div>
                        </div>
                    </section>
                    ` : ''}

                    ${decisionTree ? `
                    <section class="decision-tree">
                        <h2>Which Tool For The Job?</h2>
                        <p class="lead">${decisionTree.intro}</p>
                        <div class="decisions">
                            ${decisionTree.options.map(opt => `
                                <div class="decision-option ${opt.recommended ? 'recommended' : ''}">
                                    <div class="decision-header">
                                        <code>${opt.code}</code>
                                        ${opt.recommended ? '<span class="badge">Recommended</span>' : ''}
                                    </div>
                                    <p class="decision-when"><strong>When:</strong> ${opt.when}</p>
                                    <p class="decision-why">${opt.why}</p>
                                </div>
                            `).join('')}
                        </div>
                    </section>
                    ` : ''}

                    <section class="quick-example">
                        <h2>Quick Example</h2>
                        <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
                    </section>

                    <section class="practical">
                        <h2>Practical Tips</h2>
                        ${this._getPracticalTips(rule.id)}
                    </section>

                    <section class="deep-dive">
                        <h2>Complete Reference</h2>
                        ${this._markdownToHtml(rule.deepExplanation)}
                    </section>
                </div>

                <section class="resources">
                    <h2>Official Documentation</h2>
                    
                    <!-- Dynamic official docs section -->
                    <div id="official-doc-content" class="official-doc">
                        <div class="loading-indicator">
                            <span class="spinner"></span>
                            Fetching from docs.rust-lang.org...
                        </div>
                    </div>
                    
                    <ul class="resource-list">
                        ${this._getResourceLinks(rule.id)}
                    </ul>
                </section>

                <footer>
                    <div class="meta">
                        <span class="meta-item">${Math.round(rule.confidence * 100)}% confidence</span>
                        <span class="meta-item">${rule.contexts.join(', ')}</span>
                    </div>
                </footer>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                // Tab switching
                const tabs = document.querySelectorAll('.level-tab');
                const contents = document.querySelectorAll('.level-content');

                tabs.forEach(tab => {
                    tab.addEventListener('click', () => {
                        const level = tab.dataset.level;
                        
                        tabs.forEach(t => t.classList.remove('active'));
                        tab.classList.add('active');
                        
                        contents.forEach(c => {
                            c.classList.remove('active');
                            if (c.classList.contains(level + '-content')) {
                                c.classList.add('active');
                            }
                        });
                    });
                });

                // Handle messages from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    
                    if (message.command === 'officialDocResult') {
                        const container = document.getElementById('official-doc-content');
                        if (!container) return;
                        
                        if (message.success && message.content) {
                            const doc = message.content;
                            let html = '<div class="fetched-doc">';
                            
                            // Source attribution
                            html += '<div class="doc-source">';
                            html += '<span class="source-badge">📖 Official Rust Documentation</span>';
                            if (message.url) {
                                html += ' <a href="#" onclick="openExternal(\\'' + message.url + '\\'); return false;" class="source-link">View on docs.rust-lang.org →</a>';
                            }
                            html += '</div>';
                            
                            // Description from official docs
                            if (doc.description) {
                                html += '<blockquote class="official-quote">' + escapeHtml(doc.description) + '</blockquote>';
                            }
                            
                            // Signature if available
                            if (doc.signature) {
                                html += '<pre class="signature"><code>' + escapeHtml(doc.signature) + '</code></pre>';
                            }
                            
                            // Examples from docs
                            if (doc.examples && doc.examples.length > 0) {
                                html += '<details class="doc-examples"><summary>Examples from official docs</summary>';
                                doc.examples.forEach(ex => {
                                    html += '<pre><code class="language-rust">' + escapeHtml(ex) + '</code></pre>';
                                });
                                html += '</details>';
                            }
                            
                            html += '</div>';
                            container.innerHTML = html;
                        } else {
                            // Show fallback with link
                            let html = '<div class="doc-fallback">';
                            if (message.url) {
                                html += '<a href="#" onclick="openExternal(\\'' + message.url + '\\'); return false;" class="doc-link">📖 View official documentation →</a>';
                            } else {
                                html += '<span class="doc-unavailable">Documentation lookup unavailable</span>';
                            }
                            html += '</div>';
                            container.innerHTML = html;
                        }
                    }
                });

                function escapeHtml(text) {
                    const div = document.createElement('div');
                    div.textContent = text;
                    return div.innerHTML;
                }

                function openExternal(url) {
                    vscode.postMessage({ command: 'openExternal', url: url });
                }
            </script>
        </body>
        </html>`;
    }

    private _getErrorHtml(errorCode: string, errorMessage: string, rules: Rule[]): string {
        const rulesHtml = rules.map(rule => `
            <div class="related-rule">
                <h3>${this._escapeHtml(rule.title)}</h3>
                <code>${this._escapeHtml(rule.rustTerm)}</code>
                <p>${this._escapeHtml(rule.explanation)}</p>
                <details>
                    <summary>Show example</summary>
                    <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
                </details>
            </div>
        `).join('');

        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${errorCode || 'Error Help'}</title>
            ${this._getStyles()}
        </head>
        <body>
            <div class="container">
                <header class="error-header">
                    <h1>🔴 Compiler Error ${errorCode ? `<span class="error-code">${errorCode}</span>` : ''}</h1>
                </header>

                <section class="error-message">
                    <pre>${this._escapeHtml(errorMessage)}</pre>
                </section>

                <section class="thinking">
                    <h2>🧠 How to Think About This</h2>
                    <p>This error is related to <strong>ownership, borrowing, or type mismatches</strong> in Rust. 
                    The compiler is trying to protect you from memory safety issues.</p>
                    <p>Here are some patterns that might help you understand and fix this:</p>
                </section>

                <section class="related-rules">
                    <h2>💡 Related Patterns</h2>
                    ${rulesHtml}
                </section>

                ${errorCode ? `
                <section class="resources">
                    <h2>📚 Official Documentation</h2>
                    <ul class="resource-list">
                        <li><a href="https://doc.rust-lang.org/error_codes/${errorCode}.html">
                            📖 Rust ${errorCode} Documentation
                        </a></li>
                        <li><a href="https://doc.rust-lang.org/book/ch04-00-understanding-ownership.html">
                            📖 The Rust Book: Ownership
                        </a></li>
                    </ul>
                </section>
                ` : ''}
            </div>
        </body>
        </html>`;
    }

    private _getBeginnerExplanation(ruleId: string): {
        simple: string;
        analogy: string;
        wrongCode: string;
        wrongExplain: string;
        rightCode: string;
        rightExplain: string;
        quickRules: string[];
        mistakes: Array<{ wrong: string; right: string }>;
    } | null {
        const explanations: Record<string, {
            simple: string;
            analogy: string;
            wrongCode: string;
            wrongExplain: string;
            rightCode: string;
            rightExplain: string;
            quickRules: string[];
            mistakes: Array<{ wrong: string; right: string }>;
        }> = {
            'iterator-next-without-peekable': {
                simple: "When you read through a list one item at a time, calling .next() moves you forward AND takes the item away. If you just want to look at the next item without taking it, you need .peek().",
                analogy: "Imagine a deck of cards. Using .next() is like drawing a card - it's now in your hand, not in the deck. Using .peek() is like lifting the corner of the top card to see what it is - the card stays in the deck.",
                wrongCode: `let mut chars = "hello".chars();
let first = chars.next();  // 'h' - gone from iterator
let second = chars.next(); // 'e' - also gone
// Oops! Can't go back to 'h'`,
                wrongExplain: "Each .next() call removes the item from the iterator. You can't go back.",
                rightCode: `let mut chars = "hello".chars().peekable();
let peeked = chars.peek(); // See 'h' without removing
let first = chars.next();  // Now take 'h'
// peeked was just a look, first is the actual value`,
                rightExplain: "With .peekable(), you can look ahead without losing your place.",
                quickRules: [
                    "<code>.next()</code> = take the item and move forward",
                    "<code>.peek()</code> = look at next item but don't take it",
                    "You need to call <code>.peekable()</code> first before you can use <code>.peek()</code>",
                    "Use peek when you need to decide what to do based on what's coming next"
                ],
                mistakes: [
                    { wrong: "Calling .next() multiple times to \"look around\"", right: "Use .peek() to look without consuming" },
                    { wrong: "Forgetting to call .peekable() first", right: "Always: iterator.peekable() before .peek()" }
                ]
            },
            'iter-vs-into-iter': {
                simple: "When you loop through a list, Rust needs to know: do you want to borrow the items (look at them) or take them (move them out of the list)?",
                analogy: "Think of a library book. Borrowing with .iter() means you read the book and return it - the library still has it. Taking with .into_iter() means you buy the book - the library doesn't have it anymore.",
                wrongCode: `let names = vec!["Alice", "Bob"];
for name in names {  // This TAKES the items!
    println!("{}", name);
}
// Error! 'names' is gone, you can't use it anymore`,
                wrongExplain: "Using 'for x in collection' takes ownership. The collection is empty after the loop.",
                rightCode: `let names = vec!["Alice", "Bob"];
for name in &names {  // This BORROWS the items
    println!("{}", name);
}
// 'names' still works! You can use it again`,
                rightExplain: "Adding & means you're borrowing. The collection keeps its items.",
                quickRules: [
                    "<code>for x in &list</code> = borrow, list still usable after",
                    "<code>for x in list</code> = take ownership, list is gone after",
                    "<code>.iter()</code> = same as &list (borrowing)",
                    "<code>.into_iter()</code> = same as just list (taking)"
                ],
                mistakes: [
                    { wrong: "Using 'for x in list' then trying to use list again", right: "Use 'for x in &list' if you need list afterwards" },
                    { wrong: "Not knowing why the compiler says \"value moved\"", right: "You took ownership instead of borrowing" }
                ]
            },
            'excessive-clone': {
                simple: ".clone() makes a complete copy of your data. It works, but copying takes time and memory. Often you can just borrow instead of copying.",
                analogy: "Imagine you have a recipe card. Using .clone() is like photocopying the whole card. Using & (borrowing) is like just pointing at the card - no copying needed, everyone looks at the same card.",
                wrongCode: `fn greet(name: String) {
    println!("Hello {}", name);
}

let my_name = String::from("Alice");
greet(my_name.clone()); // Making a copy
greet(my_name.clone()); // Another copy!`,
                wrongExplain: "Each .clone() copies all the data. Works but wasteful.",
                rightCode: `fn greet(name: &str) {  // Takes a borrow
    println!("Hello {}", name);
}

let my_name = String::from("Alice");
greet(&my_name); // Just borrow
greet(&my_name); // Borrow again - no copying!`,
                rightExplain: "Borrowing with & lets the function read the data without copying.",
                quickRules: [
                    "<code>.clone()</code> = make a complete copy (slow, uses memory)",
                    "<code>&</code> = borrow, just look at data (fast, no copy)",
                    "Ask: \"Do I need my own copy, or can I just look?\"",
                    "Cloning is fine when prototyping - optimize later"
                ],
                mistakes: [
                    { wrong: "Adding .clone() every time the compiler complains", right: "First try to borrow with & instead" },
                    { wrong: "Thinking clone is always bad", right: "Clone is fine when you actually need separate copies" }
                ]
            },
            'string-vs-str': {
                simple: "String is text you own and can change. &str is a view of someone else's text - you can read it but not change it. Functions usually want &str because it's more flexible.",
                analogy: "String is like owning a whiteboard - you can write and erase. &str is like looking at someone else's whiteboard - you can read it, but you can't change what's written.",
                wrongCode: `fn greet(name: String) {  // Wants ownership
    println!("Hello {}", name);
}

greet("Alice");  // Error! "Alice" is &str, not String
greet(String::from("Alice")); // Works but clunky`,
                wrongExplain: "Taking String means callers must create a String, even for simple text.",
                rightCode: `fn greet(name: &str) {  // Takes a reference
    println!("Hello {}", name);
}

greet("Alice");           // Works!
greet(&my_string);        // Also works!
greet(&owned_string[..]); // Still works!`,
                rightExplain: "&str accepts both string literals and String references.",
                quickRules: [
                    "<code>&str</code> for function parameters (more flexible)",
                    "<code>String</code> for storing in structs (you own it)",
                    "<code>\"hello\"</code> is a <code>&str</code>",
                    "<code>String::from(\"hello\")</code> or <code>\"hello\".to_string()</code> creates a String"
                ],
                mistakes: [
                    { wrong: "Always using String in function parameters", right: "Use &str for params - it accepts more types" },
                    { wrong: "Not knowing how to convert between them", right: "&my_string gives &str, \"text\".to_string() gives String" }
                ]
            },
            'unwrap-usage': {
                simple: ".unwrap() says \"I'm 100% sure there's a value here - if there isn't, crash the program.\" It's quick for testing but risky for real code.",
                analogy: "Imagine a gift box that might be empty. Using .unwrap() is like tearing it open expecting a gift - if it's empty, you'll be very upset (crash). Better to check first: \"if let Some(gift) = box\".",
                wrongCode: `let number: Option<i32> = None;
let value = number.unwrap(); // CRASH! 
// Program panics because there's no value`,
                wrongExplain: ".unwrap() on None or Err crashes your program immediately.",
                rightCode: `let number: Option<i32> = None;

// Safe way 1: provide a default
let value = number.unwrap_or(0);

// Safe way 2: check first
if let Some(v) = number {
    println!("Got: {}", v);
}`,
                rightExplain: ".unwrap_or() gives a backup value. 'if let' checks before using.",
                quickRules: [
                    "<code>.unwrap()</code> = crash if empty (only for tests/prototypes)",
                    "<code>.unwrap_or(default)</code> = use default if empty (safe)",
                    "<code>.expect(\"message\")</code> = crash with your message (documents why)",
                    "<code>if let Some(x) = ...</code> = check first, then use"
                ],
                mistakes: [
                    { wrong: "Using .unwrap() everywhere to make code compile", right: "Use .unwrap_or() or if let for safety" },
                    { wrong: "Not knowing why program randomly crashes", right: "Check for .unwrap() calls - they panic on None/Err" }
                ]
            },
            'collect-turbofish': {
                simple: "When you transform a list and want to collect the results, Rust sometimes can't figure out what type of collection you want. The ::<Type> syntax (called \"turbofish\") tells it explicitly.",
                analogy: "Imagine ordering at a restaurant. Saying \"I'll have the special\" might confuse them if there are multiple specials. Saying \"I'll have the lunch special\" (::<Vec<_>>) is clear.",
                wrongCode: `let numbers = vec![1, 2, 3];
let doubled = numbers.iter()
    .map(|x| x * 2)
    .collect(); // Error! Collect into what?`,
                wrongExplain: "Rust doesn't know if you want a Vec, HashSet, or something else.",
                rightCode: `let numbers = vec![1, 2, 3];

// Way 1: turbofish
let doubled = numbers.iter()
    .map(|x| x * 2)
    .collect::<Vec<_>>();

// Way 2: type annotation
let doubled: Vec<_> = numbers.iter()
    .map(|x| x * 2)
    .collect();`,
                rightExplain: "Tell Rust the container type. The _ means \"figure out the element type.\"",
                quickRules: [
                    "<code>.collect::&lt;Vec&lt;_&gt;&gt;()</code> = collect into a Vec",
                    "<code>let x: Vec&lt;_&gt; = ...</code> = same thing, different style",
                    "<code>_</code> means \"Rust, you figure this part out\"",
                    "You need this when Rust can't infer the collection type"
                ],
                mistakes: [
                    { wrong: "Getting confused by the ::<> syntax", right: "It just tells Rust the type - like a hint" },
                    { wrong: "Always specifying the full type like Vec<i32>", right: "Vec<_> is shorter - Rust figures out i32" }
                ]
            },
            'for-each-vs-for': {
                simple: ".for_each() is equivalent to a for loop, but break and continue are not possible from a closure. It's generally more idiomatic to use a for loop, but for_each may be more legible at the end of longer iterator chains.",
                analogy: "Think of for_each like giving instructions to someone and walking away - they'll complete every item but can't stop early. A for loop keeps you in charge - you can say \"stop!\" (break) or \"skip this one\" (continue) anytime.",
                wrongCode: `items.iter().for_each(|item| {
    if item.is_bad() {
        return;  // This doesn't exit the function!
    }
    process(item);
});
// SURPRISE: return only exits the closure, not your function`,
                wrongExplain: "return inside for_each only exits that single iteration, not your whole function. This surprises many people! Also, break and continue aren't available at all.",
                rightCode: `// More idiomatic, supports break/continue:
for item in items.iter() {
    if item.is_bad() {
        continue;  // Skip this item
    }
    if done {
        break;  // Exit the loop entirely
    }
    process(item);
}

// for_each is legible at end of chains:
items.iter()
    .filter(|x| x.is_valid())
    .map(|x| x.transform())
    .for_each(process);`,
                rightExplain: "Use for loop by default (more idiomatic). Use for_each when it's clearer at the end of a longer iterator chain.",
                quickRules: [
                    "<code>for x in items</code> = more idiomatic for most cases",
                    "<code>.for_each()</code> = legible at end of longer iterator chains",
                    "<code>break</code> and <code>continue</code> are NOT possible in for_each (it's a closure)",
                    "<code>return</code> in for_each only exits the closure, not your function!",
                    "for_each may be faster with adapters like <code>Chain</code>"
                ],
                mistakes: [
                    { wrong: "Using return in for_each expecting to exit function", right: "Use for loop with break/return instead" },
                    { wrong: "Using for_each for simple iteration", right: "for loop is more idiomatic" },
                    { wrong: "Trying to use break or continue in for_each", right: "These only work in for loops - closures can't use them" }
                ]
            },
            'for-in-loop': {
                simple: "for x in items loops through a collection. You choose whether to borrow (&items), borrow mutably (&mut items), or take ownership (items).",
                analogy: "Like going through a box of items. You can look at each item (&items), modify each item (&mut items), or take each item out of the box permanently (items).",
                wrongCode: `let items = vec![1, 2, 3];
for x in items {
    println!("{}", x);
}
// items is now empty/moved! Can't use it.
println!("{:?}", items);  // ERROR!`,
                wrongExplain: "for x in items consumes the collection. After the loop, items is gone.",
                rightCode: `let items = vec![1, 2, 3];
for x in &items {  // Borrow with &
    println!("{}", x);
}
// items still exists!
println!("{:?}", items);  // Works!`,
                rightExplain: "Using & borrows the collection - you can still use it after the loop.",
                quickRules: [
                    "<code>for x in &items</code> = borrow (read-only, keep items)",
                    "<code>for x in &mut items</code> = borrow mutably (can modify)",
                    "<code>for x in items</code> = consume (items is gone after)",
                    "Same as <code>.iter()</code>, <code>.iter_mut()</code>, <code>.into_iter()</code>"
                ],
                mistakes: [
                    { wrong: "Using 'for x in items' then wondering why items is gone", right: "Use 'for x in &items' to borrow" },
                    { wrong: "Not knowing the difference between & and no &", right: "& means borrow, no & means consume" }
                ]
            },
            'loop-keyword': {
                simple: "loop creates an infinite loop that runs forever until you break out of it. Unlike while loops, loop can return a value when you break.",
                analogy: "Like a revolving door that keeps spinning. You have to physically step out (break) to exit. But when you step out, you can carry something with you (break value).",
                wrongCode: `// while true works but compiler can't prove it terminates
while true {
    let result = try_something();
    if result.is_ok() {
        return result;
    }
}`,
                wrongExplain: "while true is less idiomatic. The compiler doesn't know this loop will always exit somehow.",
                rightCode: `// loop is clearer for infinite loops
let result = loop {
    match try_something() {
        Ok(value) => break value,  // Exit WITH a value
        Err(_) => continue,        // Try again
    }
};`,
                rightExplain: "loop is explicit about being infinite. break can return a value.",
                quickRules: [
                    "<code>loop { ... }</code> = runs forever until break",
                    "<code>break;</code> = exit the loop",
                    "<code>break value;</code> = exit AND return a value",
                    "<code>continue;</code> = skip to next iteration"
                ],
                mistakes: [
                    { wrong: "Using while true instead of loop", right: "loop is more idiomatic in Rust" },
                    { wrong: "Not knowing loop can return a value", right: "Use 'break value;' to return from loop" }
                ]
            },
            'map-filter-fold': {
                simple: ".map() transforms each item. .filter() keeps items that match a condition. .fold() combines all items into one value. They're like an assembly line for data.",
                analogy: "Think of a factory assembly line. map() is a worker that modifies each item. filter() is quality control that rejects bad items. fold() is the packing station that combines everything into one box.",
                wrongCode: `let mut results = vec![];
for item in items {
    if item > 0 {
        results.push(item * 2);
    }
}`,
                wrongExplain: "This works but requires a mutable variable and manual pushing.",
                rightCode: `let results: Vec<_> = items.iter()
    .filter(|x| **x > 0)
    .map(|x| x * 2)
    .collect();`,
                rightExplain: "Chain filter and map for a cleaner, functional style.",
                quickRules: [
                    "<code>.map(|x| ...)</code> = transform each item",
                    "<code>.filter(|x| ...)</code> = keep items where true",
                    "<code>.fold(init, |acc, x| ...)</code> = accumulate into one value",
                    "Chain them together: filter().map().collect()"
                ],
                mistakes: [
                    { wrong: "Using manual loops with push() for everything", right: "Try iterator chains for transformations" },
                    { wrong: "Forgetting that iterators are lazy", right: "Need .collect() or similar to actually run them" }
                ]
            }
        };
        return explanations[ruleId] || null;
    }

    private _getRealWorldScenario(ruleId: string): { task: string; context: string } | null {
        const scenarios: Record<string, { task: string; context: string }> = {
            'iterator-next-without-peekable': {
                task: "You're building something that reads through data character by character (like a lexer, parser, or tokenizer) and you need to look ahead without losing your place.",
                context: "For example: parsing XML tags where you need to see if the next char is '>' without consuming it, or building a lexer where you need to peek at the next character to decide what kind of token you're reading."
            },
            'iter-vs-into-iter': {
                task: "You want to loop through a collection, but you're not sure if you'll need that collection again later.",
                context: "This comes up constantly: iterating over a list of tokens, processing lines in a file, or walking through AST nodes. The key question is: do you need to use this data again after the loop?"
            },
            'collect-turbofish': {
                task: "You're transforming data from one shape to another - maybe filtering, mapping, or accumulating - and need to collect the results.",
                context: "Common when: parsing a list of strings into structured data, filtering valid items from a stream, or building up a result from multiple sources."
            },
            'excessive-clone': {
                task: "The borrow checker is complaining and you just want the code to work. Cloning feels like the easy fix.",
                context: "This happens when you're passing data between functions, storing data in structs, or when the same value is needed in multiple places. Before you clone, pause and ask: is there a better way?"
            },
            'string-vs-str': {
                task: "You're working with text and getting confused about String vs &str - when to use which?",
                context: "Every Rust project deals with this. Writing functions that take text, storing text in structs, building strings piece by piece - each has its own pattern."
            },
            'unwrap-usage': {
                task: "You have an Option or Result and you know there's a value inside, but the compiler wants you to handle the None/Err case.",
                context: "This is the #1 friction point when starting Rust. You know the file exists, you know the parse will succeed - but Rust makes you prove it."
            },
            'match-option-result': {
                task: "You need to handle different outcomes - success vs failure, Some vs None - and decide what your code should do in each case.",
                context: "This is how Rust handles what other languages do with exceptions or null checks. It's more verbose but catches bugs at compile time."
            }
        };
        return scenarios[ruleId] || null;
    }

    private _getThinkLikeRust(ruleId: string): { mindset: string; otherLangs: string; rustWay: string } | null {
        const thinking: Record<string, { mindset: string; otherLangs: string; rustWay: string }> = {
            'iterator-next-without-peekable': {
                mindset: "In Rust, iterators are zero-cost abstractions. They don't allocate memory or copy data - they're just a cursor that moves through your data.",
                otherLangs: "In Python/JS, you might index into an array (arr[i], arr[i+1]) or use multiple variables. Memory is cheap, so you don't think about it.",
                rustWay: "Rust iterators consume elements. Once you call .next(), that element is gone. If you need to look ahead, you need a tool designed for it: .peekable() gives you .peek() to look without consuming."
            },
            'iter-vs-into-iter': {
                mindset: "Every value in Rust has exactly one owner. When you iterate, you're deciding: should iteration take ownership, or just borrow?",
                otherLangs: "In garbage-collected languages, you never think about this. Loop over a list, modify it, use it again - memory management happens automatically.",
                rustWay: "Use .iter() to borrow (you keep the original). Use .into_iter() to consume (you give up the original). The compiler enforces this - which prevents a whole class of bugs."
            },
            'excessive-clone': {
                mindset: "Cloning is explicit in Rust because copying data has a cost. The language wants you to be intentional about when you pay that cost.",
                otherLangs: "In many languages, assignment copies by default (or reference-counts behind the scenes). You don't see the copies happening.",
                rustWay: "First try borrowing (&T). If you truly need separate copies of data, clone is fine - but it should be a conscious choice, not a reflex to silence the compiler."
            },
            'string-vs-str': {
                mindset: "String is data you own (can modify, grows on heap). &str is a view into someone else's string data (read-only, no allocation).",
                otherLangs: "Most languages have one string type that handles everything. You don't think about who owns the memory.",
                rustWay: "Functions should usually take &str (flexible - accepts both String and &str). Structs should own their data with String. This pattern appears everywhere in Rust."
            },
            'unwrap-usage': {
                mindset: "Rust has no null and no exceptions. Option and Result force you to acknowledge that operations can fail.",
                otherLangs: "You might check for null sometimes, or wrap things in try/catch. But often you just assume success and let runtime errors happen.",
                rustWay: "Use ? to propagate errors to callers. Use .unwrap_or() for defaults. Use match or if let for complex logic. Save .unwrap() for cases where failure is truly impossible (or acceptable as a panic)."
            }
        };
        return thinking[ruleId] || null;
    }

    private _getDecisionTree(ruleId: string): { intro: string; options: Array<{ code: string; when: string; why: string; recommended?: boolean }> } | null {
        const trees: Record<string, { intro: string; options: Array<{ code: string; when: string; why: string; recommended?: boolean }> }> = {
            'iterator-next-without-peekable': {
                intro: "You need to look at upcoming elements without consuming them. Here are your options:",
                options: [
                    { code: '.peekable() + .peek()', when: "You need to look one element ahead", why: "Most common. Zero allocation. Returns Option<&T>.", recommended: true },
                    { code: '.peekable() + .next_if()', when: "Conditionally consume the next element", why: "Perfect for lexers: consume if char matches a pattern." },
                    { code: '.collect() first', when: "You need random access (arr[i], arr[i+2])", why: "Trades memory for flexibility. Use for small data." },
                    { code: 'itertools::multipeek', when: "You need to peek multiple elements ahead", why: "External crate. Useful for complex parsers." }
                ]
            },
            'iter-vs-into-iter': {
                intro: "You want to iterate over a collection. The question is: do you need it after?",
                options: [
                    { code: '.iter()', when: "You need the collection after the loop", why: "Borrows the collection. You keep ownership.", recommended: true },
                    { code: '.into_iter()', when: "This is the last time you'll use the collection", why: "Takes ownership. Items are moved out, not borrowed." },
                    { code: '.iter_mut()', when: "You need to modify items in place", why: "Mutable borrow. Changes affect the original collection." },
                    { code: 'for x in &collection', when: "Simple iteration (syntactic sugar for .iter())", why: "Clean syntax. Equivalent to .iter()." }
                ]
            },
            'unwrap-usage': {
                intro: "You have an Option or Result and need to get the value out. Choose based on what should happen if it's empty/error:",
                options: [
                    { code: '?', when: "Let the caller handle the error", why: "Propagates the error up. Clean and idiomatic.", recommended: true },
                    { code: '.unwrap_or(default)', when: "You have a sensible default value", why: "Never panics. Returns the default if None/Err." },
                    { code: '.expect("msg")', when: "None/Err is a bug (should never happen)", why: "Panics with your message. Documents the invariant." },
                    { code: 'match / if let', when: "You need different logic for each case", why: "Full control. Verbose but explicit." },
                    { code: '.unwrap()', when: "Quick prototype or tests", why: "Panics on None/Err. Fine for throwaway code." }
                ]
            },
            'string-vs-str': {
                intro: "Working with text in Rust means choosing between owned and borrowed string types:",
                options: [
                    { code: '&str', when: "Function parameter that just reads the text", why: "Accepts both String and string literals. Flexible.", recommended: true },
                    { code: 'String', when: "Struct field that owns its data", why: "Owned, growable, heap-allocated. The struct controls its lifetime." },
                    { code: 'impl AsRef<str>', when: "You want maximum flexibility for callers", why: "Accepts String, &str, Cow, and more." },
                    { code: "Cow<'a, str>", when: "Sometimes you need to modify, sometimes not", why: "Clone-on-write. Avoids allocation when possible." }
                ]
            }
        };
        return trees[ruleId] || null;
    }

    private _getPracticalTips(ruleId: string): string {
        const tips: Record<string, string[]> = {
            'iterator-next-without-peekable': [
                'When building a lexer, wrap your `chars()` iterator in `.peekable()` right away',
                'Use `.peek()` to look at the next character without consuming it',
                'Use `.next_if(|c| condition)` to conditionally consume - great for eating whitespace',
                'Remember: once you call `.next()`, that item is gone forever from the iterator'
            ],
            'iter-vs-into-iter': [
                'Default to `.iter()` - it\'s the safest choice',
                'Only use `.into_iter()` when you\'re done with the collection',
                'In a `for` loop, Rust calls `.into_iter()` automatically on the collection',
                'Use `.iter_mut()` sparingly - prefer functional transforms like `.map()`'
            ],
            'collect-turbofish': [
                'When the compiler can\'t infer the type, use turbofish: `.collect::<Vec<_>>()`',
                'Or use a type annotation: `let v: Vec<_> = iter.collect()`',
                'The `_` lets Rust infer the element type while you specify the container',
                'You can collect into many types: Vec, HashSet, HashMap, String, Result<Vec<T>, E>'
            ],
            'excessive-clone': [
                'Ask yourself: "Do I really need a copy, or can I borrow?"',
                'Cloning is fine for prototyping - optimize later',
                'Consider `Cow<T>` when you might need to clone but usually don\'t',
                'Cloning `Rc` and `Arc` is cheap - it just increments a counter'
            ],
            'string-vs-str': [
                'Function parameters should usually take `&str` - more flexible for callers',
                'Struct fields that own data should use `String`',
                'Use `.as_str()` to get a `&str` from a `String`',
                'Use `.to_string()` or `.to_owned()` to get a `String` from a `&str`'
            ],
            'unwrap-usage': [
                '`.unwrap()` is fine in tests and quick prototypes',
                'Use `.expect("reason")` to document why the unwrap should never fail',
                'Use `?` operator to propagate errors up to the caller',
                'Use `.unwrap_or(default)` or `.unwrap_or_else(|| compute())` for fallbacks'
            ]
        };

        const ruleTips = tips[ruleId] || [
            'Hover over patterns in your code for quick hints',
            'Use the decision guide to choose the right approach',
            'When in doubt, ask AI for help with your specific code'
        ];

        return `<ul class="tips-list">
            ${ruleTips.map(tip => `<li>${tip}</li>`).join('')}
        </ul>`;
    }

    private _getResourceLinks(ruleId: string): string {
        const links: Record<string, Array<{ title: string; url: string }>> = {
            'iterator-next-without-peekable': [
                { title: 'The Rust Book: Iterators', url: 'https://doc.rust-lang.org/book/ch13-02-iterators.html' },
                { title: 'std::iter::Peekable', url: 'https://doc.rust-lang.org/std/iter/struct.Peekable.html' },
                { title: 'Rust By Example: Iterators', url: 'https://doc.rust-lang.org/rust-by-example/trait/iter.html' }
            ],
            'iter-vs-into-iter': [
                { title: 'The Rust Book: Iterators', url: 'https://doc.rust-lang.org/book/ch13-02-iterators.html' },
                { title: 'IntoIterator trait', url: 'https://doc.rust-lang.org/std/iter/trait.IntoIterator.html' },
                { title: 'Rust By Example: for loops', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/for.html' }
            ],
            'for-each-vs-for': [
                { title: 'The Rust Book: Loops', url: 'https://doc.rust-lang.org/book/ch03-05-control-flow.html#repetition-with-loops' },
                { title: 'Iterator::for_each', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.for_each' },
                { title: 'Rust By Example: for and iterators', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/for.html' }
            ],
            'for-in-loop': [
                { title: 'The Rust Book: for loops', url: 'https://doc.rust-lang.org/book/ch03-05-control-flow.html#looping-through-a-collection-with-for' },
                { title: 'Rust By Example: for and range', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/for.html' },
                { title: 'The Rust Book: Iterators', url: 'https://doc.rust-lang.org/book/ch13-02-iterators.html' }
            ],
            'loop-keyword': [
                { title: 'The Rust Book: loop', url: 'https://doc.rust-lang.org/book/ch03-05-control-flow.html#repeating-code-with-loop' },
                { title: 'Rust By Example: loop', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/loop.html' },
                { title: 'Rust By Example: Returning from loops', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/loop/return.html' }
            ],
            'map-filter-fold': [
                { title: 'The Rust Book: Processing a Series of Items with Iterators', url: 'https://doc.rust-lang.org/book/ch13-02-iterators.html' },
                { title: 'Iterator::map', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.map' },
                { title: 'Iterator::filter', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.filter' },
                { title: 'Iterator::fold', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.fold' }
            ],
            'unwrap-usage': [
                { title: 'The Rust Book: Error Handling', url: 'https://doc.rust-lang.org/book/ch09-00-error-handling.html' },
                { title: 'The Rust Book: To panic! or Not to panic!', url: 'https://doc.rust-lang.org/book/ch09-03-to-panic-or-not-to-panic.html' },
                { title: 'std::option::Option', url: 'https://doc.rust-lang.org/std/option/enum.Option.html' }
            ],
            'string-vs-str': [
                { title: 'The Rust Book: String Slices', url: 'https://doc.rust-lang.org/book/ch04-03-slices.html#string-slices' },
                { title: 'The Rust Book: Storing UTF-8 Text with Strings', url: 'https://doc.rust-lang.org/book/ch08-02-strings.html' },
                { title: 'std::string::String', url: 'https://doc.rust-lang.org/std/string/struct.String.html' }
            ],
            'excessive-clone': [
                { title: 'The Rust Book: Ownership', url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html' },
                { title: 'std::borrow::Cow', url: 'https://doc.rust-lang.org/std/borrow/enum.Cow.html' },
                { title: 'Clone trait', url: 'https://doc.rust-lang.org/std/clone/trait.Clone.html' }
            ],
            'collect-turbofish': [
                { title: 'The Rust Book: Iterators', url: 'https://doc.rust-lang.org/book/ch13-02-iterators.html' },
                { title: 'Iterator::collect', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.collect' },
                { title: 'FromIterator trait', url: 'https://doc.rust-lang.org/std/iter/trait.FromIterator.html' }
            ],
            'while-let': [
                { title: 'The Rust Book: while let', url: 'https://doc.rust-lang.org/book/ch06-03-if-let.html#while-let-conditional-loops' },
                { title: 'Rust By Example: while let', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/while_let.html' }
            ],
            'if-let': [
                { title: 'The Rust Book: if let', url: 'https://doc.rust-lang.org/book/ch06-03-if-let.html' },
                { title: 'Rust By Example: if let', url: 'https://doc.rust-lang.org/rust-by-example/flow_control/if_let.html' }
            ],
            'flat-map': [
                { title: 'Iterator::flat_map', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.flat_map' },
                { title: 'Iterator::flatten', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.flatten' }
            ],
            'enumerate': [
                { title: 'Iterator::enumerate', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.enumerate' },
                { title: 'Rust By Example: Iterator::enumerate', url: 'https://doc.rust-lang.org/rust-by-example/iter.html' }
            ],
            'zip-iterator': [
                { title: 'Iterator::zip', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.zip' }
            ],
            'take-skip': [
                { title: 'Iterator::take', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.take' },
                { title: 'Iterator::skip', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.skip' },
                { title: 'Iterator::take_while', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.take_while' }
            ],
            'find-any-all': [
                { title: 'Iterator::find', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.find' },
                { title: 'Iterator::any', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.any' },
                { title: 'Iterator::all', url: 'https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.all' }
            ]
        };

        const ruleLinks = links[ruleId] || [
            { title: 'The Rust Book', url: 'https://doc.rust-lang.org/book/' },
            { title: 'Rust By Example', url: 'https://doc.rust-lang.org/rust-by-example/' },
            { title: 'Rust Standard Library', url: 'https://doc.rust-lang.org/std/' }
        ];

        return ruleLinks.map(link =>
            `<li><a href="${link.url}">${link.title}</a></li>`
        ).join('');
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private _markdownToHtml(markdown: string): string {
        return markdown
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/```rust\n([\s\S]*?)```/g, '<pre><code class="language-rust">$1</code></pre>')
            .replace(/```\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/\|(.+)\|/g, (match) => {
                const cells = match.split('|').filter(c => c.trim());
                const isHeader = cells.some(c => c.includes('---'));
                if (isHeader) return '';
                const tag = 'td';
                return `<tr>${cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('')}</tr>`;
            });
    }

    private _getStyles(): string {
        return `<style>
            * {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            body {
                font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
                font-size: 14px;
                line-height: 1.6;
                color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background);
                padding: 24px;
                max-width: 800px;
            }

            /* Header */
            header {
                margin-bottom: 24px;
                padding-bottom: 16px;
                border-bottom: 1px solid var(--vscode-widget-border);
            }

            h1 {
                font-size: 20px;
                font-weight: 600;
                margin-bottom: 8px;
            }

            .rust-term {
                font-family: var(--vscode-editor-font-family, monospace);
                font-size: 13px;
                color: var(--vscode-textLink-foreground);
            }

            /* Tabs */
            .level-tabs {
                display: flex;
                gap: 0;
                margin-bottom: 24px;
                border-bottom: 1px solid var(--vscode-widget-border);
            }

            .level-tab {
                background: none;
                border: none;
                padding: 8px 16px;
                font-size: 13px;
                color: var(--vscode-descriptionForeground);
                cursor: pointer;
                border-bottom: 2px solid transparent;
                margin-bottom: -1px;
            }

            .level-tab:hover {
                color: var(--vscode-editor-foreground);
            }

            .level-tab.active {
                color: var(--vscode-editor-foreground);
                border-bottom-color: var(--vscode-textLink-foreground);
            }

            .level-content {
                display: none;
            }

            .level-content.active {
                display: block;
            }

            /* Sections */
            section {
                margin-bottom: 24px;
            }

            h3 {
                font-size: 14px;
                font-weight: 600;
                margin-bottom: 12px;
                color: var(--vscode-editor-foreground);
            }

            /* Lead text */
            .lead {
                font-size: 14px;
                line-height: 1.7;
                margin-bottom: 12px;
            }

            /* Key points */
            .key-points {
                margin: 16px 0;
                padding-left: 20px;
            }

            .key-points li {
                margin-bottom: 6px;
            }

            /* Gotchas */
            .gotchas {
                margin: 16px 0;
                padding: 12px;
                background: rgba(255, 200, 50, 0.06);
                border-left: 3px solid rgba(200, 160, 50, 0.5);
                border-radius: 0 4px 4px 0;
                color: var(--vscode-editor-foreground);
            }

            .gotchas strong {
                display: block;
                margin-bottom: 8px;
                color: var(--vscode-editor-foreground);
            }

            .gotchas ul {
                margin: 0;
                padding-left: 20px;
                color: var(--vscode-editor-foreground);
            }

            .gotchas li {
                margin-bottom: 4px;
                color: var(--vscode-editor-foreground);
            }

            /* Code */
            code {
                font-family: var(--vscode-editor-font-family, 'SF Mono', 'Consolas', monospace);
                font-size: 13px;
                background: var(--vscode-textCodeBlock-background);
                padding: 2px 6px;
                border-radius: 3px;
            }

            pre {
                background: var(--vscode-textCodeBlock-background);
                padding: 16px;
                border-radius: 6px;
                overflow-x: auto;
                margin: 12px 0;
                border: 1px solid var(--vscode-widget-border);
            }

            pre code {
                background: none;
                padding: 0;
                font-size: 13px;
                line-height: 1.6;
                color: var(--vscode-editor-foreground);
                white-space: pre-wrap;
                word-wrap: break-word;
            }

            /* Alternatives table */
            .alternatives-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 13px;
                margin-top: 8px;
            }

            .alternatives-table th,
            .alternatives-table td {
                text-align: left;
                padding: 10px 12px;
                border-bottom: 1px solid var(--vscode-widget-border);
                vertical-align: top;
            }

            .alternatives-table th {
                font-weight: 600;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                color: var(--vscode-descriptionForeground);
            }

            .alternatives-table td:first-child {
                white-space: nowrap;
            }

            .alternatives-table td:first-child code {
                font-weight: 600;
            }

            .current-row {
                background: var(--vscode-list-activeSelectionBackground, rgba(100, 100, 255, 0.1));
            }

            .recommended-row td:first-child code {
                color: var(--vscode-testing-iconPassed, #3fb950);
            }

            .tag {
                display: inline-block;
                font-size: 10px;
                padding: 2px 6px;
                border-radius: 3px;
                margin-left: 6px;
                background: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
            }

            .tag.recommended {
                background: var(--vscode-testing-iconPassed, #3fb950);
                color: white;
            }

            /* Go deeper link */
            .go-deeper {
                margin-top: 24px;
                padding-top: 16px;
                border-top: 1px solid var(--vscode-widget-border);
            }

            .switch-tab-link {
                color: var(--vscode-textLink-foreground);
                text-decoration: none;
            }

            .switch-tab-link:hover {
                text-decoration: underline;
            }

            /* Official docs section */
            .official-content {
                margin-bottom: 24px;
            }

            .source-badge {
                font-size: 11px;
                color: var(--vscode-descriptionForeground);
                margin-bottom: 12px;
            }

            .official-description {
                font-size: 14px;
                line-height: 1.7;
                margin: 0 0 16px 0;
                padding: 12px 16px;
                background: var(--vscode-textBlockQuote-background);
                border-left: 3px solid var(--vscode-textLink-foreground);
            }

            .read-more {
                color: var(--vscode-textLink-foreground);
                text-decoration: none;
            }

            .read-more:hover {
                text-decoration: underline;
            }

            /* Fallback */
            .fallback-content {
                padding: 16px;
                background: rgba(255, 200, 50, 0.06);
                border-left: 3px solid rgba(200, 160, 50, 0.5);
                border-radius: 0 4px 4px 0;
                color: var(--vscode-editor-foreground);
            }

            .warning-badge {
                font-weight: 600;
                margin-bottom: 12px;
                color: var(--vscode-editor-foreground);
            }

            /* External links */
            .external-link {
                color: var(--vscode-textLink-foreground);
                text-decoration: none;
            }

            .external-link:hover {
                text-decoration: underline;
            }

            /* Signature */
            .signature-section pre {
                margin: 0;
            }

            /* Examples */
            .examples-section pre {
                margin-bottom: 12px;
            }

            /* Related links */
            .related-section ul {
                list-style: none;
                padding: 0;
            }

            .related-section li {
                padding: 6px 0;
            }

            /* Loading */
            .loading-section {
                text-align: center;
                padding: 40px;
                color: var(--vscode-descriptionForeground);
            }

            .spinner {
                display: inline-block;
                width: 16px;
                height: 16px;
                border: 2px solid var(--vscode-widget-border);
                border-top-color: var(--vscode-textLink-foreground);
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
                margin-right: 8px;
            }

            @keyframes spin {
                to { transform: rotate(360deg); }
            }
        </style>`;
    }

    public dispose() {
        LearnPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
