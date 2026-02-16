import * as vscode from "vscode";
import type { Rule } from "../rules";
import {
	explanationSimplifier,
	type FetchedDocContent,
	RustDocsFetcher,
	rustDocsFetcher,
	type SimplifiedExplanation,
} from "../services";

/**
 * A full-page webview panel for learning content
 * Opens as an editor tab, not a sidebar
 */
export class LearnPanel {
	public static currentPanel: LearnPanel | undefined;
	private static readonly viewType = "rustCompass.learnPanel";

	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];
	private _currentRule: Rule | undefined;

	private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
		this._panel = panel;

		// Set initial content
		this._panel.webview.html = this._getLoadingHtml();

		// Handle messages from webview
		this._panel.webview.onDidReceiveMessage(
			(message) => this._handleMessage(message),
			null,
			this._disposables,
		);

		// Handle disposal
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
	}

	/**
	 * Handle messages from the webview
	 */
	private async _handleMessage(message: { command: string; url?: string; term?: string }) {
		switch (message.command) {
			case "fetchOfficialDoc":
				await this._fetchAndUpdateOfficialDoc(message.url, message.term);
				break;
			case "openExternal":
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
			const cleanTerm =
				this._currentRule.rustTerm.replace(/[():]/g, "").split("::").pop() || "";
			docUrl = RustDocsFetcher.buildDocUrl(cleanTerm) || undefined;
		}

		if (!docUrl) {
			this._panel.webview.postMessage({
				command: "officialDocResult",
				success: false,
				error: "Could not determine documentation URL",
			});
			return;
		}

		try {
			const content = await rustDocsFetcher.fetchDoc(docUrl);
			this._panel.webview.postMessage({
				command: "officialDocResult",
				success: !!content,
				content,
				url: docUrl,
			});
		} catch {
			this._panel.webview.postMessage({
				command: "officialDocResult",
				success: false,
				error: "Failed to fetch documentation",
				url: docUrl,
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
				retainContextWhenHidden: true,
			},
		);

		LearnPanel.currentPanel = new LearnPanel(panel, extensionUri);
		LearnPanel.currentPanel._update(rule);
	}

	/**
	 * Show error help content
	 */
	public static showError(
		extensionUri: vscode.Uri,
		errorCode: string,
		errorMessage: string,
		rules: Rule[],
	) {
		const column = vscode.ViewColumn.Beside;

		if (LearnPanel.currentPanel) {
			LearnPanel.currentPanel._panel.reveal(column);
			LearnPanel.currentPanel._updateError(errorCode, errorMessage, rules);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			LearnPanel.viewType,
			`🔴 ${errorCode || "Compiler Error"}`,
			column,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
				retainContextWhenHidden: true,
			},
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
		const docUrl =
			rule.officialDoc ||
			RustDocsFetcher.buildDocUrl(
				rule.rustTerm.replace(/[():]/g, "").split("::").pop() || "",
			);

		let fetchedDoc: FetchedDocContent | null = null;
		if (docUrl) {
			try {
				fetchedDoc = await rustDocsFetcher.fetchDoc(docUrl);
			} catch (e) {
				console.error("Failed to fetch docs:", e);
			}
		}

		// Try to simplify for beginners using LLM (if available)
		let simplified: SimplifiedExplanation | null = null;
		if (fetchedDoc?.description) {
			try {
				simplified = await explanationSimplifier.simplify(
					rule.rustTerm,
					fetchedDoc.description,
					rule.title,
				);
			} catch (e) {
				console.error("Failed to simplify explanation:", e);
			}
		}

		// Render with fetched content (or fallback)
		this._panel.webview.html = this._getDocBasedHtml(
			rule,
			fetchedDoc,
			docUrl || undefined,
			simplified,
		);
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
	private _getDocBasedHtml(
		rule: Rule,
		doc: FetchedDocContent | null,
		docUrl?: string,
		simplified?: SimplifiedExplanation | null,
	): string {
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
                        
                        ${
							simplified?.keyPoints && simplified.keyPoints.length > 0
								? `
                        <ul class="key-points">
                            ${simplified.keyPoints.map((point) => `<li>${this._escapeHtml(point)}</li>`).join("")}
                        </ul>
                        `
								: ""
						}
                        
                        ${
							simplified?.gotchas && simplified.gotchas.length > 0
								? `
                        <div class="gotchas">
                            <strong>Watch out:</strong>
                            <ul>
                                ${simplified.gotchas.map((gotcha) => `<li>${this._escapeHtml(gotcha)}</li>`).join("")}
                            </ul>
                        </div>
                        `
								: ""
						}
                    </section>
                    
                    <section class="simple-example">
                        <h3>Example</h3>
                        <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
                    </section>
                    
                    ${
						alternatives
							? `
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
                                ${alternatives.options
									.map(
										(opt) => `
                                <tr class="${opt.current ? "current-row" : ""} ${opt.recommended ? "recommended-row" : ""}">
                                    <td>
                                        <code>${opt.code}</code>
                                        ${opt.current ? '<span class="tag">current</span>' : ""}
                                        ${opt.recommended ? '<span class="tag recommended">recommended</span>' : ""}
                                    </td>
                                    <td>${opt.description}</td>
                                    <td>${opt.useWhen}</td>
                                </tr>
                                `,
									)
									.join("")}
                            </tbody>
                        </table>
                    </section>
                    `
							: ""
					}
                    
                    ${
						docUrl
							? `
                    <p class="go-deeper">
                        <a href="#" class="switch-tab-link" data-target="intermediate">Read official documentation →</a>
                    </p>
                    `
							: ""
					}
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
			"iterator-next-without-peekable": {
				title: "All Iterator Methods",
				intro: "When iterating, you have several options depending on whether you need to look ahead, consume items, or both:",
				options: [
					{
						code: ".next()",
						description: "Get and remove the next item",
						useWhen: "You want to consume items one by one",
						current: true,
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#tymethod.next",
					},
					{
						code: ".peek()",
						description: "Look at next item without removing it",
						useWhen: "You need to see what's next before deciding",
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/iter/struct.Peekable.html#method.peek",
					},
					{
						code: ".peekable()",
						description: "Convert iterator to support peeking",
						useWhen: "You need lookahead capability",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.peekable",
					},
					{
						code: ".take(n)",
						description: "Get only first n items",
						useWhen: "You only need a limited number",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.take",
					},
					{
						code: ".skip(n)",
						description: "Skip first n items",
						useWhen: "You want to start from a later position",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.skip",
					},
					{
						code: ".nth(n)",
						description: "Get item at position n",
						useWhen: "You need a specific position",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.nth",
					},
				],
			},

			// iter vs into_iter
			"iter-vs-into-iter": {
				title: "Ways to Iterate",
				intro: "Choose how you want to access items - borrow them, modify them, or take ownership:",
				options: [
					{
						code: ".iter()",
						description: "Borrow items (&T)",
						useWhen: "You want to read items, keep the collection",
						current: true,
						docUrl: "https://doc.rust-lang.org/std/iter/trait.IntoIterator.html",
					},
					{
						code: ".iter_mut()",
						description: "Mutably borrow items (&mut T)",
						useWhen: "You need to modify items in place",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.IntoIterator.html",
					},
					{
						code: ".into_iter()",
						description: "Take ownership (T)",
						useWhen: "You're done with the collection, want to transform it",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.IntoIterator.html",
					},
					{
						code: "for x in &items",
						description: "Same as .iter()",
						useWhen: "Cleaner syntax for borrowing",
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/keyword.for.html",
					},
					{
						code: "for x in &mut items",
						description: "Same as .iter_mut()",
						useWhen: "Cleaner syntax for mutable access",
						docUrl: "https://doc.rust-lang.org/std/keyword.for.html",
					},
				],
			},

			// for_each vs for loop
			"for-each-vs-for": {
				title: "Looping Options",
				intro: "Different ways to process each item in a collection:",
				options: [
					{
						code: "for x in items",
						description: "Standard for loop",
						useWhen: "Most cases - clear, supports break/continue",
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/keyword.for.html",
					},
					{
						code: ".for_each(|x| ...)",
						description: "Closure on each item",
						useWhen: "End of iterator chains, no break needed",
						current: true,
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.for_each",
					},
					{
						code: "while let Some(x) = iter.next()",
						description: "Manual iteration",
						useWhen: "You need fine control over iteration",
						docUrl: "https://doc.rust-lang.org/std/keyword.while.html",
					},
					{
						code: "loop { }",
						description: "Infinite loop with break",
						useWhen: "Complex control flow, return values from loop",
						docUrl: "https://doc.rust-lang.org/std/keyword.loop.html",
					},
					{
						code: ".try_for_each(|x| ...)",
						description: "for_each with early exit",
						useWhen: "You need to stop early on error/condition",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.try_for_each",
					},
				],
			},

			// unwrap alternatives
			"unwrap-usage": {
				title: "Handling Option/Result",
				intro: "Many ways to handle values that might be missing or errors:",
				options: [
					{
						code: ".unwrap()",
						description: "Panic if None/Err",
						useWhen: "Tests, prototypes, impossible cases",
						current: true,
						docUrl: "https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap",
					},
					{
						code: "?",
						description: "Propagate error up",
						useWhen: "Let caller handle the error",
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/result/index.html#the-question-mark-operator-",
					},
					{
						code: '.expect("msg")',
						description: "Panic with custom message",
						useWhen: "Documenting why it should never fail",
						docUrl: "https://doc.rust-lang.org/std/option/enum.Option.html#method.expect",
					},
					{
						code: ".unwrap_or(default)",
						description: "Use default if None/Err",
						useWhen: "You have a sensible fallback value",
						docUrl: "https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap_or",
					},
					{
						code: ".unwrap_or_default()",
						description: "Use Default::default()",
						useWhen: "Type has a Default impl",
						docUrl: "https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap_or_default",
					},
					{
						code: "match / if let",
						description: "Handle each case explicitly",
						useWhen: "You need different logic for each case",
						docUrl: "https://doc.rust-lang.org/std/keyword.match.html",
					},
					{
						code: ".ok_or(err)",
						description: "Convert Option to Result",
						useWhen: "You want to use ? with Option",
						docUrl: "https://doc.rust-lang.org/std/option/enum.Option.html#method.ok_or",
					},
				],
			},

			// map/filter/fold
			"map-filter-fold": {
				title: "Iterator Transformations",
				intro: "Transform and combine items in different ways:",
				options: [
					{
						code: ".map(|x| ...)",
						description: "Transform each item",
						useWhen: "Convert items to new values",
						current: true,
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.map",
					},
					{
						code: ".filter(|x| ...)",
						description: "Keep only matching items",
						useWhen: "Remove items that don't match",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.filter",
					},
					{
						code: ".filter_map(|x| ...)",
						description: "Filter and transform in one",
						useWhen: "Transform returns Option, skip None",
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.filter_map",
					},
					{
						code: ".fold(init, |acc, x| ...)",
						description: "Reduce to single value",
						useWhen: "Combine all items into one result",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.fold",
					},
					{
						code: ".reduce(|acc, x| ...)",
						description: "Fold without initial value",
						useWhen: "First item is the initial accumulator",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.reduce",
					},
					{
						code: ".flat_map(|x| ...)",
						description: "Map then flatten",
						useWhen: "Each item maps to multiple items",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.flat_map",
					},
					{
						code: ".collect()",
						description: "Gather into collection",
						useWhen: "Build Vec, HashMap, String, etc.",
						docUrl: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.collect",
					},
				],
			},

			// collect
			"collect-turbofish": {
				title: "Collecting Into Types",
				intro: "collect() can create many different collection types:",
				options: [
					{
						code: ".collect::<Vec<_>>()",
						description: "Into a vector",
						useWhen: "You need an ordered, growable list",
						current: true,
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/vec/struct.Vec.html",
					},
					{
						code: ".collect::<HashSet<_>>()",
						description: "Into a hash set",
						useWhen: "You need unique values, fast lookup",
						docUrl: "https://doc.rust-lang.org/std/collections/struct.HashSet.html",
					},
					{
						code: ".collect::<HashMap<_, _>>()",
						description: "Into a hash map",
						useWhen: "From iterator of (key, value) tuples",
						docUrl: "https://doc.rust-lang.org/std/collections/struct.HashMap.html",
					},
					{
						code: ".collect::<String>()",
						description: "Into a string",
						useWhen: "From iterator of chars or &str",
						docUrl: "https://doc.rust-lang.org/std/string/struct.String.html",
					},
					{
						code: ".collect::<Result<Vec<_>, _>>()",
						description: "Collect with error handling",
						useWhen: "Each item might fail, stop on first error",
						docUrl: "https://doc.rust-lang.org/std/result/enum.Result.html#impl-FromIterator%3CResult%3CA,+E%3E%3E-for-Result%3CV,+E%3E",
					},
					{
						code: ".collect::<Option<Vec<_>>>()",
						description: "Collect Options",
						useWhen: "Each item might be None, get None if any None",
						docUrl: "https://doc.rust-lang.org/std/option/enum.Option.html#impl-FromIterator%3COption%3CA%3E%3E-for-Option%3CV%3E",
					},
				],
			},

			// String vs str
			"string-vs-str": {
				title: "String Types",
				intro: "Rust has multiple string types for different needs:",
				options: [
					{
						code: "&str",
						description: "String slice (borrowed)",
						useWhen: "Reading strings, function parameters",
						current: true,
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/primitive.str.html",
					},
					{
						code: "String",
						description: "Owned, growable string",
						useWhen: "Building strings, storing in structs",
						docUrl: "https://doc.rust-lang.org/std/string/struct.String.html",
					},
					{
						code: "&String",
						description: "Reference to owned string",
						useWhen: "Rarely needed - use &str instead",
						docUrl: "https://doc.rust-lang.org/std/string/struct.String.html",
					},
					{
						code: "Cow<str>",
						description: "Clone-on-write string",
						useWhen: "Might need to modify borrowed data",
						docUrl: "https://doc.rust-lang.org/std/borrow/enum.Cow.html",
					},
					{
						code: "Box<str>",
						description: "Owned slice on heap",
						useWhen: "Fixed-size string, saving memory",
						docUrl: "https://doc.rust-lang.org/std/boxed/struct.Box.html",
					},
				],
			},

			// Match patterns
			"match-exhaustive": {
				title: "Pattern Matching Options",
				intro: "Different ways to match and destructure values:",
				options: [
					{
						code: "match value { }",
						description: "Full pattern matching",
						useWhen: "Multiple cases, complex patterns",
						current: true,
						docUrl: "https://doc.rust-lang.org/std/keyword.match.html",
					},
					{
						code: "if let Some(x) = opt",
						description: "Match single pattern",
						useWhen: "You only care about one case",
						recommended: true,
						docUrl: "https://doc.rust-lang.org/std/keyword.if.html",
					},
					{
						code: "let else",
						description: "Match or diverge",
						useWhen: "Must match, otherwise return/break",
						docUrl: "https://doc.rust-lang.org/std/keyword.let.html",
					},
					{
						code: "while let",
						description: "Loop while pattern matches",
						useWhen: "Process until pattern fails",
						docUrl: "https://doc.rust-lang.org/std/keyword.while.html",
					},
					{
						code: "matches!(val, pat)",
						description: "Check if pattern matches",
						useWhen: "Just need true/false",
						docUrl: "https://doc.rust-lang.org/std/macro.matches.html",
					},
				],
			},
		};

		return alternatives[ruleId] || null;
	}

	/**
	 * Render content from official documentation
	 */
	private _renderOfficialDoc(doc: FetchedDocContent, docUrl?: string): string {
		let html = "";

		// Official description - THE main content
		html += `
        <section class="official-content">
            <div class="source-badge">📖 From Official Rust Documentation</div>
            <blockquote class="official-description">
                ${this._escapeHtml(doc.description)}
            </blockquote>
            ${docUrl ? `<a href="${docUrl}" class="external-link read-more">Read full documentation →</a>` : ""}
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
                ${doc.examples
					.map(
						(ex) => `
                    <pre><code class="language-rust">${this._escapeHtml(ex)}</code></pre>
                `,
					)
					.join("")}
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
            
            ${
				docUrl
					? `
            <div class="manual-link">
                <p>View the official documentation directly:</p>
                <a href="${docUrl}" class="external-link doc-button">📖 Open docs.rust-lang.org →</a>
            </div>
            `
					: ""
			}
        </section>`;
	}

	/**
	 * Get related documentation links
	 */
	private _getRelatedLinks(currentUrl?: string): string {
		if (!currentUrl) {
			return "";
		}

		// Determine related topics based on URL
		const relatedLinks: Array<{ title: string; url: string }> = [];

		if (currentUrl.includes("Iterator")) {
			relatedLinks.push(
				{
					title: "Iterator trait",
					url: "https://doc.rust-lang.org/std/iter/trait.Iterator.html",
				},
				{
					title: "The Rust Book: Iterators",
					url: "https://doc.rust-lang.org/book/ch13-02-iterators.html",
				},
			);
		}
		if (currentUrl.includes("Option") || currentUrl.includes("Result")) {
			relatedLinks.push(
				{
					title: "Option enum",
					url: "https://doc.rust-lang.org/std/option/enum.Option.html",
				},
				{
					title: "Result enum",
					url: "https://doc.rust-lang.org/std/result/enum.Result.html",
				},
				{
					title: "The Rust Book: Error Handling",
					url: "https://doc.rust-lang.org/book/ch09-00-error-handling.html",
				},
			);
		}
		if (currentUrl.includes("String") || currentUrl.includes("str")) {
			relatedLinks.push(
				{
					title: "String type",
					url: "https://doc.rust-lang.org/std/string/struct.String.html",
				},
				{
					title: "str primitive",
					url: "https://doc.rust-lang.org/std/primitive.str.html",
				},
				{
					title: "The Rust Book: Strings",
					url: "https://doc.rust-lang.org/book/ch08-02-strings.html",
				},
			);
		}

		// Filter out current URL
		const filtered = relatedLinks.filter((l) => l.url !== currentUrl);

		if (filtered.length === 0) {
			return "";
		}

		return `
        <section class="related-section">
            <h2>Related Documentation</h2>
            <ul class="related-links">
                ${filtered
					.map(
						(link) => `
                    <li><a href="${link.url}" class="external-link">${link.title}</a></li>
                `,
					)
					.join("")}
            </ul>
        </section>`;
	}

	private _updateError(errorCode: string, errorMessage: string, rules: Rule[]) {
		this._panel.title = `🔴 ${errorCode || "Error Help"}`;
		this._panel.webview.html = this._getErrorHtml(errorCode, errorMessage, rules);
	}

	private _getLoadingHtml(): string {
		return `<!DOCTYPE html>
        <html><body><p>Loading...</p></body></html>`;
	}

	private _getErrorHtml(errorCode: string, errorMessage: string, rules: Rule[]): string {
		const rulesHtml = rules
			.map(
				(rule) => `
            <div class="related-rule">
                <h3>${this._escapeHtml(rule.title)}</h3>
                <code>${this._escapeHtml(rule.rustTerm)}</code>
                <p>${this._escapeHtml(rule.explanation)}</p>
                <details>
                    <summary>Show example</summary>
                    <pre><code class="language-rust">${this._escapeHtml(rule.example)}</code></pre>
                </details>
            </div>
        `,
			)
			.join("");

		return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${errorCode || "Error Help"}</title>
            ${this._getStyles()}
        </head>
        <body>
            <div class="container">
                <header class="error-header">
                    <h1>🔴 Compiler Error ${errorCode ? `<span class="error-code">${errorCode}</span>` : ""}</h1>
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

                ${
					errorCode
						? `
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
                `
						: ""
				}
            </div>
        </body>
        </html>`;
	}

	private _escapeHtml(text: string): string {
		return text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
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
