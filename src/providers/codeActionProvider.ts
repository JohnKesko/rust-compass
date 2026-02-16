import * as vscode from "vscode";
import type { ProjectContext, RuleEngine } from "../rules";

export class RustCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix,
		vscode.CodeActionKind.Refactor,
	];

	constructor(
		private ruleEngine: RuleEngine,
		private getContext: () => ProjectContext,
	) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		_context: vscode.CodeActionContext,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.CodeAction[]> {
		const actions: vscode.CodeAction[] = [];

		const match = this.ruleEngine.findMatchAtPosition(document, range.start, this.getContext());

		if (!match || !match.rule.suggestedFix) {
			return actions;
		}

		const fix = match.rule.suggestedFix;

		// Create action
		const action = new vscode.CodeAction(
			`Rust Compass: ${fix.description}`,
			vscode.CodeActionKind.QuickFix,
		);

		// Find the text to replace (look backwards from match)
		const lineText = document.lineAt(match.range.line).text;
		const beforeIndex = lineText.indexOf(fix.before);

		if (beforeIndex !== -1) {
			const startPos = new vscode.Position(match.range.line, beforeIndex);
			const endPos = new vscode.Position(match.range.line, beforeIndex + fix.before.length);

			action.edit = new vscode.WorkspaceEdit();
			action.edit.replace(document.uri, new vscode.Range(startPos, endPos), fix.after);
			action.isPreferred = true;

			actions.push(action);
		}

		// Add "Learn more" action
		const learnAction = new vscode.CodeAction(
			`📖 Learn about ${match.rule.rustTerm}`,
			vscode.CodeActionKind.Empty,
		);
		learnAction.command = {
			command: "rust-compass.showRuleDetails",
			title: "Show Details",
			arguments: [{ ruleId: match.rule.id }],
		};
		actions.push(learnAction);

		return actions;
	}
}
