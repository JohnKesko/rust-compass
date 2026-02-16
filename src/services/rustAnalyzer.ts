import * as vscode from "vscode";

/**
 * Interface for rust-analyzer hover information
 */
export interface RustAnalyzerHoverInfo {
	type?: string;
	documentation?: string;
	signature?: string;
}

/**
 * Interface for rust-analyzer type information
 */
export interface RustAnalyzerTypeInfo {
	typeName: string;
	isIterator: boolean;
	isOption: boolean;
	isResult: boolean;
	innerType?: string;
}

/**
 * Service to interact with rust-analyzer LSP
 */
export class RustAnalyzerService {
	private static instance: RustAnalyzerService;

	public static getInstance(): RustAnalyzerService {
		if (!RustAnalyzerService.instance) {
			RustAnalyzerService.instance = new RustAnalyzerService();
		}
		return RustAnalyzerService.instance;
	}

	/**
	 * Check if rust-analyzer extension is available
	 */
	public async isAvailable(): Promise<boolean> {
		const extension = vscode.extensions.getExtension("rust-lang.rust-analyzer");
		if (!extension) {
			return false;
		}
		if (!extension.isActive) {
			try {
				await extension.activate();
			} catch {
				return false;
			}
		}
		return true;
	}

	/**
	 * Get hover information at a position using VS Code's built-in hover command
	 */
	public async getHoverInfo(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<RustAnalyzerHoverInfo | undefined> {
		try {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				"vscode.executeHoverProvider",
				document.uri,
				position,
			);

			if (!hovers || hovers.length === 0) {
				return undefined;
			}

			// Parse the hover content from rust-analyzer
			const hoverContent = hovers
				.flatMap((h) => h.contents)
				.map((c) => {
					if (typeof c === "string") {
						return c;
					}
					if (c instanceof vscode.MarkdownString) {
						return c.value;
					}
					if ("value" in c) {
						return c.value;
					}
					return "";
				})
				.join("\n");

			return this.parseHoverContent(hoverContent);
		} catch (error) {
			console.error("Error getting hover info:", error);
			return undefined;
		}
	}

	/**
	 * Get type information at a position
	 */
	public async getTypeInfo(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<RustAnalyzerTypeInfo | undefined> {
		const hoverInfo = await this.getHoverInfo(document, position);
		if (!hoverInfo?.type) {
			return undefined;
		}

		return this.parseTypeString(hoverInfo.type);
	}

	/**
	 * Parse hover content from rust-analyzer
	 */
	private parseHoverContent(content: string): RustAnalyzerHoverInfo {
		const info: RustAnalyzerHoverInfo = {};

		// Extract type from rust code block
		// rust-analyzer typically formats as: ```rust\ntype_info\n```
		const rustCodeMatch = content.match(/```rust\n([\s\S]*?)```/);
		if (rustCodeMatch) {
			info.type = rustCodeMatch[1].trim();
		}

		// Look for signature patterns
		const sigMatch = content.match(/fn\s+\w+[^{]+/);
		if (sigMatch) {
			info.signature = sigMatch[0].trim();
		}

		// Extract documentation (text outside code blocks)
		const docMatch = content.replace(/```[\s\S]*?```/g, "").trim();
		if (docMatch) {
			info.documentation = docMatch;
		}

		return info;
	}

	/**
	 * Parse a type string into structured info
	 */
	private parseTypeString(typeStr: string): RustAnalyzerTypeInfo {
		const info: RustAnalyzerTypeInfo = {
			typeName: typeStr,
			isIterator: false,
			isOption: false,
			isResult: false,
		};

		// Check for common types
		if (
			typeStr.includes("Iterator") ||
			typeStr.includes("Iter") ||
			typeStr.includes("IntoIter")
		) {
			info.isIterator = true;
			// Try to extract Item type
			const itemMatch = typeStr.match(/Item\s*=\s*([^,>]+)/);
			if (itemMatch) {
				info.innerType = itemMatch[1].trim();
			}
		}

		if (typeStr.startsWith("Option<") || typeStr.includes("Option<")) {
			info.isOption = true;
			const innerMatch = typeStr.match(/Option<(.+)>/);
			if (innerMatch) {
				info.innerType = innerMatch[1].trim();
			}
		}

		if (typeStr.startsWith("Result<") || typeStr.includes("Result<")) {
			info.isResult = true;
			const innerMatch = typeStr.match(/Result<([^,]+)/);
			if (innerMatch) {
				info.innerType = innerMatch[1].trim();
			}
		}

		// Check for specific types
		if (typeStr.includes("Peekable")) {
			info.typeName = "Peekable";
		} else if (typeStr.includes("Chars")) {
			info.typeName = "Chars";
			info.isIterator = true;
			info.innerType = "char";
		} else if (typeStr.includes("String")) {
			info.typeName = "String";
		} else if (typeStr === "&str" || typeStr.includes("&str")) {
			info.typeName = "&str";
		} else if (typeStr.includes("Rc<")) {
			info.typeName = "Rc";
		} else if (typeStr.includes("Arc<")) {
			info.typeName = "Arc";
		} else if (typeStr.includes("Vec<")) {
			info.typeName = "Vec";
		}

		return info;
	}

	/**
	 * Get definition location for a symbol
	 */
	public async getDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Location | undefined> {
		try {
			const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
				"vscode.executeDefinitionProvider",
				document.uri,
				position,
			);

			return definitions?.[0];
		} catch {
			return undefined;
		}
	}

	/**
	 * Check if we're inside a loop construct
	 */
	public async isInsideLoop(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<boolean> {
		// Simple heuristic: look backwards for loop keywords
		const text = document.getText(
			new vscode.Range(new vscode.Position(Math.max(0, position.line - 20), 0), position),
		);

		// Count open braces and loop keywords
		const loopPattern = /\b(for|while|loop)\b[^{]*\{/g;
		let loopCount = 0;
		while (loopPattern.exec(text) !== null) {
			loopCount++;
		}

		// Count closing braces after loop keywords
		const closeBraces = (text.match(/\}/g) || []).length;

		// Rough heuristic: if we have more loop openings than closes, we're likely in a loop
		return loopCount > closeBraces;
	}
}
