import * as vscode from "vscode";
import {
	RustCodeActionProvider,
	RustDecorationProvider,
	RustHoverProvider,
	SmartDiagnosticProvider,
} from "./providers";
import { type ProjectContext, RuleEngine } from "./rules";
import { CargoAnalyzerService, CompilerErrorLinker, PatternTracker } from "./services";
import { LearnPanel } from "./webview";

let decorationProvider: RustDecorationProvider;
let smartDiagnosticProvider: SmartDiagnosticProvider;
let currentContext: ProjectContext = "general";
let cargoAnalyzer: CargoAnalyzerService;
let compilerErrorLinker: CompilerErrorLinker;
let patternTracker: PatternTracker;

export function activate(context: vscode.ExtensionContext) {
	console.log("Rust Compass is now active!");

	// Initialize rule engine
	const ruleEngine = new RuleEngine(context.extensionPath);

	// Initialize Cargo analyzer
	cargoAnalyzer = CargoAnalyzerService.getInstance();
	cargoAnalyzer.initialize().then(async () => {
		// Check if we should suggest a project context
		const suggestion = await cargoAnalyzer.suggestProjectContext();
		if (suggestion) {
			const config = vscode.workspace.getConfiguration("rustCompass");
			const currentSetting = config.get<ProjectContext>("projectContext");

			// Only suggest if not already set
			if (!currentSetting || currentSetting === "general") {
				const choice = await vscode.window.showInformationMessage(
					`🦀 ${suggestion.reason}. Set project context to "${suggestion.context}"?`,
					"Yes",
					"Not now",
				);
				if (choice === "Yes") {
					await config.update(
						"projectContext",
						suggestion.context,
						vscode.ConfigurationTarget.Workspace,
					);
					currentContext = suggestion.context as ProjectContext;
					vscode.window.showInformationMessage(
						`Project context set to: ${suggestion.context}`,
					);
				}
			}
		}
	});
	context.subscriptions.push({ dispose: () => cargoAnalyzer.dispose() });

	// Context getter
	const getContext = (): ProjectContext => {
		const config = vscode.workspace.getConfiguration("rustCompass");
		return config.get<ProjectContext>("projectContext") || currentContext;
	};

	// Register Hover Provider
	const hoverProvider = new RustHoverProvider(ruleEngine, getContext);
	context.subscriptions.push(vscode.languages.registerHoverProvider("rust", hoverProvider));

	// Initialize Pattern Tracker
	patternTracker = PatternTracker.getInstance();
	patternTracker.initialize(context.globalState);
	context.subscriptions.push(patternTracker);

	// Track patterns and show milestones
	patternTracker.onMilestone(({ ruleId, message }) => {
		const rule = ruleEngine.getRuleById(ruleId);
		const ruleName = rule?.title || ruleId;

		vscode.window
			.showInformationMessage(`🦀 ${ruleName}: ${message}`, "Hide This Hint", "Learn More")
			.then((choice) => {
				if (choice === "Hide This Hint") {
					decorationProvider.dismissRule(ruleId);
					patternTracker.markAsLearned(ruleId);
				} else if (choice === "Learn More" && rule) {
					LearnPanel.show(context.extensionUri, rule);
				}
			});
	});

	// Track patterns on hover (no auto-update panel anymore)
	context.subscriptions.push(
		hoverProvider.onRuleHovered((rule) => {
			patternTracker.recordPattern(rule.id);
		}),
	);

	// Register Decoration Provider
	decorationProvider = new RustDecorationProvider(ruleEngine, getContext);
	context.subscriptions.push(decorationProvider);

	// Load dismissed rules from global state
	const dismissedRules = context.globalState.get<string[]>("dismissedRules") || [];
	decorationProvider.loadDismissedRules(dismissedRules);

	// Save dismissed rules when they change
	decorationProvider.onDismissedChanged((dismissed) => {
		context.globalState.update("dismissedRules", Array.from(dismissed));
	});

	// Initialize Compiler Error Linker
	compilerErrorLinker = new CompilerErrorLinker(ruleEngine);
	context.subscriptions.push(compilerErrorLinker);

	// Initialize Smart Diagnostic Provider (intent-based squiggly hints)
	smartDiagnosticProvider = new SmartDiagnosticProvider(ruleEngine);
	context.subscriptions.push(smartDiagnosticProvider);

	// When a compiler error is linked to a hint, offer to show help
	compilerErrorLinker.onErrorLinked(({ error, rules }) => {
		if (rules.length > 0) {
			const errorCode = extractErrorCode(error);
			vscode.window
				.showInformationMessage(
					`🦀 Rust Compass can help with this ${errorCode || "error"}`,
					"Show Help",
				)
				.then((choice) => {
					if (choice === "Show Help") {
						LearnPanel.showError(
							context.extensionUri,
							errorCode || "",
							error.message,
							rules,
						);
					}
				});
		}
	});

	// Register Code Action Provider
	const codeActionProvider = new RustCodeActionProvider(ruleEngine, getContext);
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider("rust", codeActionProvider, {
			providedCodeActionKinds: RustCodeActionProvider.providedCodeActionKinds,
		}),
	);

	// Register Commands
	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.toggleHints", () => {
			const config = vscode.workspace.getConfiguration("rustCompass");
			const enabled = config.get("enabled");
			config.update("enabled", !enabled, vscode.ConfigurationTarget.Workspace);
			vscode.window.showInformationMessage(
				`Rust Compass hints ${!enabled ? "enabled" : "disabled"}`,
			);
		}),
	);

	// Show learning progress
	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.showProgress", async () => {
			const session = patternTracker.getSessionSummary();
			const allTime = patternTracker.getAllTimeSummary();

			// Show in quick pick for better formatting
			const suggested = patternTracker.getSuggestedLearning();
			const items: Array<{
				label: string;
				description: string;
				ruleId?: string;
			}> = [
				{
					label: "📊 Session Stats",
					description: `${session.totalPatterns} patterns (${session.uniquePatterns} unique)`,
				},
				{
					label: "📈 All Time",
					description: `${allTime.totalPatterns} total patterns seen`,
				},
				...suggested.slice(0, 3).map((s) => {
					const rule = ruleEngine.getRuleById(s.ruleId);
					return {
						label: `💡 ${rule?.title || s.ruleId}`,
						description: `Seen ${s.count}x — ready to mark as learned?`,
						ruleId: s.ruleId,
					};
				}),
			];

			const choice = await vscode.window.showQuickPick(items, {
				placeHolder: "Your Rust Compass Learning Progress",
			});

			if (choice?.ruleId) {
				const rule = ruleEngine.getRuleById(choice.ruleId);
				if (rule) {
					LearnPanel.show(context.extensionUri, rule);
				}
			}
		}),
	);

	// Dismiss a rule (hide its lightbulb)
	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.dismissRule", (args: { ruleId: string }) => {
			const rule = ruleEngine.getRuleById(args.ruleId);
			if (rule) {
				decorationProvider.dismissRule(args.ruleId);
				vscode.window.showInformationMessage(
					`"${rule.title}" hint hidden. Use "Rust Compass: Restore Hidden Hints" to show again.`,
				);
			}
		}),
	);

	// Show detected dependencies
	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.showDependencies", async () => {
			const summary = await cargoAnalyzer.getDependencySummary();
			vscode.window.showInformationMessage(summary, { modal: false });
		}),
	);

	// Restore all dismissed rules
	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.restoreAllHints", async () => {
			const dismissed = decorationProvider.getDismissedRules();
			if (dismissed.length === 0) {
				vscode.window.showInformationMessage("No hidden hints to restore.");
				return;
			}

			const choice = await vscode.window.showQuickPick(
				[
					{
						label: "Restore All",
						description: `Restore all ${dismissed.length} hidden hints`,
						value: "all",
					},
					...dismissed.map((id) => {
						const rule = ruleEngine.getRuleById(id);
						return {
							label: rule?.title || id,
							description: rule?.rustTerm || "",
							value: id,
						};
					}),
				],
				{ placeHolder: "Select hints to restore" },
			);

			if (choice) {
				if (choice.value === "all") {
					decorationProvider.restoreAllRules();
					vscode.window.showInformationMessage(
						`Restored ${dismissed.length} hidden hints.`,
					);
				} else {
					decorationProvider.restoreRule(choice.value);
					vscode.window.showInformationMessage(`Restored "${choice.label}" hint.`);
				}
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.setProjectContext", async () => {
			const options: ProjectContext[] = ["general", "parser", "web", "cli", "systems"];
			const descriptions: Record<ProjectContext, string> = {
				general: "General Rust development",
				parser: "Lexers, parsers, compilers",
				web: "Web services and APIs",
				cli: "Command-line applications",
				systems: "Systems programming, low-level",
			};

			const items = options.map((opt) => ({
				label: opt.charAt(0).toUpperCase() + opt.slice(1),
				description: descriptions[opt],
				value: opt,
			}));

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: "Select your project context for more relevant hints",
			});

			if (selected) {
				currentContext = selected.value;
				const config = vscode.workspace.getConfiguration("rustCompass");
				await config.update(
					"projectContext",
					selected.value,
					vscode.ConfigurationTarget.Workspace,
				);
				vscode.window.showInformationMessage(`Project context set to: ${selected.label}`);

				// Refresh decorations
				if (vscode.window.activeTextEditor) {
					decorationProvider.triggerUpdate(vscode.window.activeTextEditor);
				}
			}
		}),
	);

	// Learn more command - opens the learn panel for a rule
	context.subscriptions.push(
		vscode.commands.registerCommand("rust-compass.learnMore", (args: { ruleId: string }) => {
			const rule = ruleEngine.getRuleById(args.ruleId);
			if (rule) {
				LearnPanel.show(context.extensionUri, rule);
			}
		}),
	);

	// Ask AI - opens GitHub Copilot Chat with context about the Rust pattern
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"rust-compass.askAI",
			async (args: { prompt: string; ruleId: string }) => {
				const decodedPrompt = decodeURIComponent(args.prompt);

				// Try to use GitHub Copilot Chat if available
				try {
					const copilotExt = vscode.extensions.getExtension("github.copilot-chat");
					if (copilotExt) {
						await vscode.commands.executeCommand("workbench.action.chat.open", {
							query: decodedPrompt,
						});
					} else {
						await vscode.env.clipboard.writeText(decodedPrompt);
						const choice = await vscode.window.showInformationMessage(
							"AI prompt copied to clipboard! Paste it into your preferred AI assistant.",
							"Install Copilot Chat",
						);
						if (choice === "Install Copilot Chat") {
							vscode.commands.executeCommand(
								"workbench.extensions.search",
								"github.copilot-chat",
							);
						}
					}
				} catch (_err) {
					await vscode.env.clipboard.writeText(decodedPrompt);
					vscode.window.showInformationMessage("AI prompt copied to clipboard!");
				}
			},
		),
	);

	// Listen for editor changes to update decorations
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && editor.document.languageId === "rust") {
				decorationProvider.triggerUpdate(editor);
			}
		}),
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument((event) => {
			const editor = vscode.window.activeTextEditor;
			if (
				editor &&
				event.document === editor.document &&
				editor.document.languageId === "rust"
			) {
				decorationProvider.triggerUpdate(editor);
			}
		}),
	);

	// Initial decoration update
	if (vscode.window.activeTextEditor?.document.languageId === "rust") {
		decorationProvider.triggerUpdate(vscode.window.activeTextEditor);
	}

	// Show welcome message on first activation
	const hasShownWelcome = context.globalState.get("hasShownWelcome");
	if (!hasShownWelcome) {
		vscode.window
			.showInformationMessage(
				"Welcome to Rust Compass! 🦀 Hover over Rust code to see contextual hints.",
				"Set Project Context",
			)
			.then((selection) => {
				if (selection === "Set Project Context") {
					vscode.commands.executeCommand("rust-compass.setProjectContext");
				}
			});
		context.globalState.update("hasShownWelcome", true);
	}
}

function extractErrorCode(diagnostic: vscode.Diagnostic): string | null {
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
	const messageMatch = diagnostic.message.match(/\[E(\d{4})\]/);
	return messageMatch ? `E${messageMatch[1]}` : null;
}

export function deactivate() {
	console.log("Rust Compass deactivated");
}
