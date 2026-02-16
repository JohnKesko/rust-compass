import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Detected dependencies and their categories
 */
export interface DetectedDependencies {
	async: string[]; // tokio, async-std, smol
	web: string[]; // actix-web, axum, warp, rocket
	serialization: string[]; // serde, serde_json, toml, ron
	cli: string[]; // clap, structopt, argh
	parsing: string[]; // nom, pest, lalrpop, logos
	error: string[]; // anyhow, thiserror, eyre
	database: string[]; // sqlx, diesel, sea-orm
	testing: string[]; // proptest, quickcheck, criterion
	other: string[];
}

/**
 * Dependency patterns - maps crate names to categories
 */
const DEPENDENCY_PATTERNS: Record<keyof DetectedDependencies, string[]> = {
	async: ["tokio", "async-std", "smol", "futures", "async-trait"],
	web: ["actix-web", "actix-rt", "axum", "warp", "rocket", "hyper", "reqwest", "tower"],
	serialization: ["serde", "serde_json", "serde_yaml", "toml", "ron", "bincode", "postcard"],
	cli: ["clap", "structopt", "argh", "pico-args", "lexopt"],
	parsing: ["nom", "pest", "lalrpop", "logos", "chumsky", "winnow", "combine"],
	error: ["anyhow", "thiserror", "eyre", "color-eyre", "miette"],
	database: ["sqlx", "diesel", "sea-orm", "rusqlite", "mongodb", "redis"],
	testing: ["proptest", "quickcheck", "criterion", "fake", "mockall"],
	other: [],
};

/**
 * Service to analyze Cargo.toml and detect project dependencies
 */
export class CargoAnalyzerService {
	private static instance: CargoAnalyzerService;
	private cachedDependencies: DetectedDependencies | null = null;
	private fileWatcher: vscode.FileSystemWatcher | null = null;

	// Event emitter for dependency changes
	private _onDependenciesChanged = new vscode.EventEmitter<DetectedDependencies>();
	public readonly onDependenciesChanged = this._onDependenciesChanged.event;

	public static getInstance(): CargoAnalyzerService {
		if (!CargoAnalyzerService.instance) {
			CargoAnalyzerService.instance = new CargoAnalyzerService();
		}
		return CargoAnalyzerService.instance;
	}

	/**
	 * Initialize the service and start watching Cargo.toml
	 */
	public async initialize(): Promise<void> {
		// Watch for Cargo.toml changes
		this.fileWatcher = vscode.workspace.createFileSystemWatcher("**/Cargo.toml");
		this.fileWatcher.onDidChange(() => this.invalidateCache());
		this.fileWatcher.onDidCreate(() => this.invalidateCache());
		this.fileWatcher.onDidDelete(() => this.invalidateCache());

		// Initial scan
		await this.scanDependencies();
	}

	/**
	 * Get detected dependencies (cached)
	 */
	public async getDependencies(): Promise<DetectedDependencies> {
		if (!this.cachedDependencies) {
			await this.scanDependencies();
		}
		return this.cachedDependencies || this.emptyDependencies();
	}

	/**
	 * Check if a specific category of dependencies is used
	 */
	public async hasCategory(category: keyof DetectedDependencies): Promise<boolean> {
		const deps = await this.getDependencies();
		return deps[category].length > 0;
	}

	/**
	 * Get suggested project context based on dependencies
	 */
	public async suggestProjectContext(): Promise<{
		context: string;
		reason: string;
	} | null> {
		const deps = await this.getDependencies();

		// Priority order for context suggestion
		if (deps.parsing.length > 0) {
			return {
				context: "parser",
				reason: `Using ${deps.parsing.join(", ")} - parser/lexer project detected`,
			};
		}
		if (deps.web.length > 0) {
			return {
				context: "web",
				reason: `Using ${deps.web.join(", ")} - web project detected`,
			};
		}
		if (deps.cli.length > 0) {
			return {
				context: "cli",
				reason: `Using ${deps.cli.join(", ")} - CLI project detected`,
			};
		}
		if (deps.async.length > 0 && deps.database.length > 0) {
			return {
				context: "web",
				reason: `Using async runtime + database - likely a backend service`,
			};
		}

		return null;
	}

	/**
	 * Get dependency-specific hints that should be surfaced
	 */
	public async getRelevantHintCategories(): Promise<string[]> {
		const deps = await this.getDependencies();
		const categories: string[] = ["general"]; // Always include general

		if (deps.async.length > 0) {
			categories.push("async");
		}
		if (deps.serialization.length > 0) {
			categories.push("serialization");
		}
		if (deps.error.length > 0) {
			categories.push("error-handling-advanced");
		}
		if (deps.parsing.length > 0) {
			categories.push("parser");
		}

		return categories;
	}

	/**
	 * Get specific dependency info for display
	 */
	public async getDependencySummary(): Promise<string> {
		const deps = await this.getDependencies();
		const parts: string[] = [];

		if (deps.async.length > 0) {
			parts.push(`⚡ Async: ${deps.async.join(", ")}`);
		}
		if (deps.web.length > 0) {
			parts.push(`🌐 Web: ${deps.web.join(", ")}`);
		}
		if (deps.serialization.length > 0) {
			parts.push(`📦 Serde: ${deps.serialization.join(", ")}`);
		}
		if (deps.parsing.length > 0) {
			parts.push(`🔍 Parsing: ${deps.parsing.join(", ")}`);
		}
		if (deps.error.length > 0) {
			parts.push(`⚠️ Errors: ${deps.error.join(", ")}`);
		}
		if (deps.cli.length > 0) {
			parts.push(`💻 CLI: ${deps.cli.join(", ")}`);
		}

		return parts.length > 0 ? parts.join("\n") : "No notable dependencies detected";
	}

	/**
	 * Scan Cargo.toml files in the workspace
	 */
	private async scanDependencies(): Promise<void> {
		const cargoFiles = await vscode.workspace.findFiles("**/Cargo.toml", "**/target/**");

		if (cargoFiles.length === 0) {
			this.cachedDependencies = this.emptyDependencies();
			return;
		}

		// Use the first Cargo.toml found (usually the root one)
		// Sort to prioritize root Cargo.toml
		const sortedFiles = cargoFiles.sort(
			(a, b) => a.fsPath.split(path.sep).length - b.fsPath.split(path.sep).length,
		);

		try {
			const content = await vscode.workspace.fs.readFile(sortedFiles[0]);
			const tomlContent = Buffer.from(content).toString("utf-8");
			this.cachedDependencies = this.parseDependencies(tomlContent);
			this._onDependenciesChanged.fire(this.cachedDependencies);
		} catch (err) {
			console.error("Failed to read Cargo.toml:", err);
			this.cachedDependencies = this.emptyDependencies();
		}
	}

	/**
	 * Parse dependencies from TOML content
	 */
	private parseDependencies(tomlContent: string): DetectedDependencies {
		const deps = this.emptyDependencies();

		// Simple regex-based parsing (works for most Cargo.toml files)
		// Matches: dependency_name = "version" or dependency_name = { version = "x" }
		const depSections = [
			/\[dependencies\]([\s\S]*?)(?=\[|$)/,
			/\[dev-dependencies\]([\s\S]*?)(?=\[|$)/,
			/\[build-dependencies\]([\s\S]*?)(?=\[|$)/,
		];

		for (const sectionRegex of depSections) {
			const match = tomlContent.match(sectionRegex);
			if (match) {
				const section = match[1];
				// Match dependency names (handles various TOML formats)
				const depMatches = section.matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm);

				for (const depMatch of depMatches) {
					const depName = depMatch[1].toLowerCase().replace(/_/g, "-");
					this.categorizeDependency(depName, deps);
				}
			}
		}

		return deps;
	}

	/**
	 * Categorize a dependency into the appropriate category
	 */
	private categorizeDependency(depName: string, deps: DetectedDependencies): void {
		for (const [category, patterns] of Object.entries(DEPENDENCY_PATTERNS)) {
			if (category === "other") {
				continue;
			}

			for (const pattern of patterns) {
				// Check if dep name matches or starts with the pattern
				if (depName === pattern || depName.startsWith(pattern + "-")) {
					(deps[category as keyof DetectedDependencies] as string[]).push(depName);
					return;
				}
			}
		}
		// If no category matched, add to other
		deps.other.push(depName);
	}

	/**
	 * Create empty dependencies object
	 */
	private emptyDependencies(): DetectedDependencies {
		return {
			async: [],
			web: [],
			serialization: [],
			cli: [],
			parsing: [],
			error: [],
			database: [],
			testing: [],
			other: [],
		};
	}

	/**
	 * Invalidate cache and re-scan
	 */
	private async invalidateCache(): Promise<void> {
		this.cachedDependencies = null;
		await this.scanDependencies();
	}

	/**
	 * Dispose resources
	 */
	public dispose(): void {
		this.fileWatcher?.dispose();
		this._onDependenciesChanged.dispose();
	}
}
