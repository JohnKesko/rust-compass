import * as vscode from "vscode";
import type { ProjectContext, RuleEngine } from "../rules";

export class RustDecorationProvider {
	private decorationType: vscode.TextEditorDecorationType;
	private timeout: NodeJS.Timeout | undefined;
	private dismissedRules: Set<string> = new Set();
	private onDismissedChangedEmitter = new vscode.EventEmitter<Set<string>>();
	public readonly onDismissedChanged = this.onDismissedChangedEmitter.event;

	constructor(
		private ruleEngine: RuleEngine,
		private getContext: () => ProjectContext,
	) {
		this.decorationType = vscode.window.createTextEditorDecorationType({
			borderWidth: "0 0 1px 0",
			borderStyle: "dotted",
			borderColor: new vscode.ThemeColor("editorInfo.foreground"),
			after: {
				contentText: " 💡",
				color: new vscode.ThemeColor("editorInfo.foreground"),
			},
		});
	}

	/**
	 * Load dismissed rules from global state
	 */
	public loadDismissedRules(dismissed: string[]): void {
		this.dismissedRules = new Set(dismissed);
	}

	/**
	 * Dismiss a rule (hide its lightbulb)
	 */
	public dismissRule(ruleId: string): void {
		this.dismissedRules.add(ruleId);
		this.onDismissedChangedEmitter.fire(this.dismissedRules);

		// Refresh decorations
		if (vscode.window.activeTextEditor) {
			this.triggerUpdate(vscode.window.activeTextEditor);
		}
	}

	/**
	 * Restore a dismissed rule
	 */
	public restoreRule(ruleId: string): void {
		this.dismissedRules.delete(ruleId);
		this.onDismissedChangedEmitter.fire(this.dismissedRules);

		// Refresh decorations
		if (vscode.window.activeTextEditor) {
			this.triggerUpdate(vscode.window.activeTextEditor);
		}
	}

	/**
	 * Restore all dismissed rules
	 */
	public restoreAllRules(): void {
		this.dismissedRules.clear();
		this.onDismissedChangedEmitter.fire(this.dismissedRules);

		// Refresh decorations
		if (vscode.window.activeTextEditor) {
			this.triggerUpdate(vscode.window.activeTextEditor);
		}
	}

	/**
	 * Get list of dismissed rule IDs
	 */
	public getDismissedRules(): string[] {
		return Array.from(this.dismissedRules);
	}

	/**
	 * Check if a rule is dismissed
	 */
	public isRuleDismissed(ruleId: string): boolean {
		return this.dismissedRules.has(ruleId);
	}

	public triggerUpdate(editor: vscode.TextEditor): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		this.timeout = setTimeout(() => this.updateDecorations(editor), 300);
	}

	private updateDecorations(editor: vscode.TextEditor): void {
		if (editor.document.languageId !== "rust") {
			return;
		}

		const config = vscode.workspace.getConfiguration("rustCompass");
		if (!config.get("enabled") || !config.get("showDecorations")) {
			editor.setDecorations(this.decorationType, []);
			return;
		}

		const matches = this.ruleEngine.findMatches(editor.document, this.getContext());

		// Filter by confidence threshold AND not dismissed
		const visibleMatches = matches.filter(
			(m) => m.rule.confidence >= 0.7 && !this.dismissedRules.has(m.rule.id),
		);

		const decorations: vscode.DecorationOptions[] = visibleMatches.map((match) => {
			const startPos = editor.document.positionAt(match.range.start);
			const endPos = editor.document.positionAt(match.range.end);

			return {
				range: new vscode.Range(startPos, endPos),
				hoverMessage: new vscode.MarkdownString(
					`**${match.rule.title}** - Hover for details`,
				),
			};
		});

		editor.setDecorations(this.decorationType, decorations);
	}

	public dispose(): void {
		this.decorationType.dispose();
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
	}
}
