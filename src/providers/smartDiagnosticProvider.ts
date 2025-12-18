import * as vscode from "vscode";
import type { RuleEngine } from "../rules";
import { intentAnalyzer } from "../services/intentAnalyzer";

/**
 * Provides diagnostic squiggly lines for teachable moments
 * These are hints based on what the user is trying to do
 */
export class SmartDiagnosticProvider implements vscode.Disposable {
	private diagnosticCollection: vscode.DiagnosticCollection;
	private disposables: vscode.Disposable[] = [];
	private debounceTimer: NodeJS.Timeout | null = null;
	private ruleEngine: RuleEngine;

	constructor(ruleEngine: RuleEngine) {
		this.ruleEngine = ruleEngine;
		this.diagnosticCollection =
			vscode.languages.createDiagnosticCollection("rust-compass");

		// Analyze on document change (debounced)
		this.disposables.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document.languageId === "rust") {
					this.scheduleAnalysis(e.document);
				}
			}),
		);

		// Analyze on document open
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((doc) => {
				if (doc.languageId === "rust") {
					this.analyzeDocument(doc);
				}
			}),
		);

		// Analyze on active editor change
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor && editor.document.languageId === "rust") {
					this.analyzeDocument(editor.document);
				}
			}),
		);

		// Clear diagnostics when document closes
		this.disposables.push(
			vscode.workspace.onDidCloseTextDocument((doc) => {
				this.diagnosticCollection.delete(doc.uri);
			}),
		);

		// Analyze current document on startup
		if (vscode.window.activeTextEditor?.document.languageId === "rust") {
			this.analyzeDocument(vscode.window.activeTextEditor.document);
		}
	}

	private scheduleAnalysis(document: vscode.TextDocument) {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		// Wait for typing to stop before analyzing
		this.debounceTimer = setTimeout(() => {
			this.analyzeDocument(document);
		}, 1000); // 1 second debounce
	}

	private async analyzeDocument(document: vscode.TextDocument) {
		const moments = intentAnalyzer.findTeachableMoments(document);
		const diagnostics: vscode.Diagnostic[] = [];

		for (const moment of moments) {
			const diagnostic = new vscode.Diagnostic(
				moment.range,
				`💡 ${moment.suggestion}`,
				moment.severity === "hint"
					? vscode.DiagnosticSeverity.Hint
					: vscode.DiagnosticSeverity.Information,
			);

			diagnostic.source = "Rust Compass";
			diagnostic.code = {
				value: moment.ruleId,
				target: vscode.Uri.parse(
					`command:rust-compass.learnMore?${encodeURIComponent(JSON.stringify({ ruleId: moment.ruleId }))}`,
				),
			};

			// Add related information showing why we detected this
			diagnostic.relatedInformation = [
				new vscode.DiagnosticRelatedInformation(
					new vscode.Location(document.uri, moment.range),
					moment.contextReason,
				),
			];

			// Add tags to style appropriately (unnecessary = faded)
			diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];

			diagnostics.push(diagnostic);
		}

		this.diagnosticCollection.set(document.uri, diagnostics);
	}

	/**
	 * Force re-analysis of current document
	 */
	refresh() {
		if (vscode.window.activeTextEditor?.document.languageId === "rust") {
			this.analyzeDocument(vscode.window.activeTextEditor.document);
		}
	}

	dispose() {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.diagnosticCollection.dispose();
		this.disposables.forEach((d) => d.dispose());
	}
}
