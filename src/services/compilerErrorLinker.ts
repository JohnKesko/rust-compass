import * as vscode from "vscode";
import type { Rule, RuleEngine } from "../rules";

/**
 * Maps Rust compiler error codes to relevant Rust Compass rules
 */
const ERROR_TO_RULE_MAP: Record<string, { ruleIds: string[]; hint: string }> = {
	// Ownership and borrowing errors
	E0382: {
		ruleIds: ["excessive-clone", "iter-vs-into-iter"],
		hint: "Value moved — consider borrowing with & or cloning",
	},
	E0505: {
		ruleIds: ["excessive-clone"],
		hint: "Cannot move out of borrowed content — you might need to clone",
	},
	E0502: {
		ruleIds: ["iter-vs-into-iter"],
		hint: "Cannot borrow as mutable — check if you need .iter_mut()",
	},
	E0507: {
		ruleIds: ["excessive-clone", "iter-vs-into-iter"],
		hint: "Cannot move out of reference — consider .clone() or restructuring",
	},

	// Option/Result handling errors
	E0277: {
		ruleIds: ["unwrap-usage", "question-mark-operator"],
		hint: "Type mismatch — check your error handling with ? or .unwrap()",
	},

	// Iterator errors
	E0271: {
		ruleIds: ["collect-turbofish"],
		hint: "Type mismatch in iterator — you may need turbofish ::<Type>",
	},
	E0282: {
		ruleIds: ["collect-turbofish"],
		hint: "Type annotation needed — try .collect::<Vec<_>>() or let v: Vec<_> =",
	},

	// String/str errors
	E0308: {
		ruleIds: ["string-vs-str"],
		hint: "Mismatched types — check String vs &str",
	},
	E0369: {
		ruleIds: ["string-vs-str"],
		hint: "Cannot add — String + &str works, but &str + &str needs format!()",
	},

	// Match exhaustiveness
	E0004: {
		ruleIds: ["match-exhaustive"],
		hint: "Non-exhaustive match — add missing arms or use _ wildcard",
	},

	// Lifetime errors (general ownership thinking)
	E0106: {
		ruleIds: ["string-vs-str", "excessive-clone"],
		hint: "Missing lifetime — you may need to borrow differently or clone",
	},
	E0597: {
		ruleIds: ["string-vs-str", "excessive-clone"],
		hint: "Value does not live long enough — consider ownership transfer or clone",
	},
};

/**
 * Service that watches for Rust compiler errors and provides helpful links
 */
export class CompilerErrorLinker implements vscode.Disposable {
	private diagnosticCollection: vscode.DiagnosticCollection;
	private disposables: vscode.Disposable[] = [];
	private ruleEngine: RuleEngine;

	// Event emitter for when we find a linkable error
	private _onErrorLinked = new vscode.EventEmitter<{
		error: vscode.Diagnostic;
		rules: Rule[];
	}>();
	public readonly onErrorLinked = this._onErrorLinked.event;

	constructor(ruleEngine: RuleEngine) {
		this.ruleEngine = ruleEngine;
		this.diagnosticCollection =
			vscode.languages.createDiagnosticCollection("rust-compass-hints");

		// Watch for diagnostic changes (from rust-analyzer)
		this.disposables.push(
			vscode.languages.onDidChangeDiagnostics(
				this.onDiagnosticsChanged.bind(this),
			),
		);
	}

	/**
	 * Called when diagnostics change in any document
	 */
	private onDiagnosticsChanged(event: vscode.DiagnosticChangeEvent): void {
		for (const uri of event.uris) {
			if (uri.fsPath.endsWith(".rs")) {
				this.processDocumentDiagnostics(uri);
			}
		}
	}

	/**
	 * Process diagnostics for a Rust file
	 */
	private processDocumentDiagnostics(uri: vscode.Uri): void {
		const diagnostics = vscode.languages.getDiagnostics(uri);
		const rustDiagnostics = diagnostics.filter(
			(d) => d.source === "rustc" || d.source === "rust-analyzer",
		);

		for (const diagnostic of rustDiagnostics) {
			this.checkForLinkableError(uri, diagnostic);
		}
	}

	/**
	 * Check if a diagnostic matches a known error pattern
	 */
	private checkForLinkableError(
		uri: vscode.Uri,
		diagnostic: vscode.Diagnostic,
	): void {
		// Extract error code from diagnostic
		const errorCode = this.extractErrorCode(diagnostic);
		if (!errorCode) {
			return;
		}

		const mapping = ERROR_TO_RULE_MAP[errorCode];
		if (!mapping) {
			return;
		}

		// Get the rules that can help
		const helpfulRules = mapping.ruleIds
			.map((id) => this.ruleEngine.getRuleById(id))
			.filter((r): r is Rule => r !== null);

		if (helpfulRules.length > 0) {
			this._onErrorLinked.fire({ error: diagnostic, rules: helpfulRules });
		}
	}

	/**
	 * Extract error code from diagnostic (e.g., "E0382")
	 */
	private extractErrorCode(diagnostic: vscode.Diagnostic): string | null {
		// Check diagnostic code
		if (diagnostic.code) {
			if (typeof diagnostic.code === "string") {
				const match = diagnostic.code.match(/E\d{4}/);
				return match ? match[0] : null;
			}
			if (typeof diagnostic.code === "object" && "value" in diagnostic.code) {
				const value = String(diagnostic.code.value);
				const match = value.match(/E\d{4}/);
				return match ? match[0] : null;
			}
		}

		// Also check message for error code
		const messageMatch = diagnostic.message.match(/\[E(\d{4})\]/);
		if (messageMatch) {
			return `E${messageMatch[1]}`;
		}

		return null;
	}

	/**
	 * Get hint text for an error code
	 */
	public getHintForError(errorCode: string): string | null {
		return ERROR_TO_RULE_MAP[errorCode]?.hint || null;
	}

	/**
	 * Get related rules for an error code
	 */
	public getRulesForError(errorCode: string): Rule[] {
		const mapping = ERROR_TO_RULE_MAP[errorCode];
		if (!mapping) {
			return [];
		}

		return mapping.ruleIds
			.map((id) => this.ruleEngine.getRuleById(id))
			.filter((r): r is Rule => r !== null);
	}

	/**
	 * Get all supported error codes
	 */
	public getSupportedErrorCodes(): string[] {
		return Object.keys(ERROR_TO_RULE_MAP);
	}

	dispose(): void {
		this.diagnosticCollection.dispose();
		this._onErrorLinked.dispose();
		this.disposables.forEach((d) => d.dispose());
	}
}
