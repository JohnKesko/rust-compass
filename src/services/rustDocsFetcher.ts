import * as http from "node:http";
import * as https from "node:https";

export interface FetchedDocContent {
	title: string;
	description: string;
	signature?: string;
	examples: string[];
	sourceUrl: string;
	fetchedAt: Date;
}

/**
 * Fetches and parses official Rust documentation
 */
export class RustDocsFetcher {
	private cache: Map<string, FetchedDocContent> = new Map();
	private cacheTimeout = 1000 * 60 * 60; // 1 hour cache

	/**
	 * Fetch documentation for a specific URL
	 */
	async fetchDoc(url: string): Promise<FetchedDocContent | null> {
		// Check cache first
		const cached = this.cache.get(url);
		if (cached && Date.now() - cached.fetchedAt.getTime() < this.cacheTimeout) {
			return cached;
		}

		try {
			const html = await this._fetchHtml(url);
			const content = this._parseDocPage(html, url);

			if (content) {
				this.cache.set(url, content);
			}

			return content;
		} catch (error) {
			console.error(`Failed to fetch Rust docs from ${url}:`, error);
			return null;
		}
	}

	/**
	 * Fetch HTML content from URL
	 */
	private _fetchHtml(url: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const protocol = url.startsWith("https") ? https : http;

			const request = protocol.get(
				url,
				{
					headers: {
						"User-Agent": "RustCompass-VSCode-Extension/1.0",
					},
				},
				(response) => {
					// Handle redirects
					if (
						response.statusCode &&
						response.statusCode >= 300 &&
						response.statusCode < 400 &&
						response.headers.location
					) {
						this._fetchHtml(response.headers.location).then(resolve).catch(reject);
						return;
					}

					if (response.statusCode !== 200) {
						reject(new Error(`HTTP ${response.statusCode}`));
						return;
					}

					let data = "";
					response.on("data", (chunk) => (data += chunk));
					response.on("end", () => resolve(data));
					response.on("error", reject);
				},
			);

			request.on("error", reject);
			request.setTimeout(10000, () => {
				request.destroy();
				reject(new Error("Request timeout"));
			});
		});
	}

	/**
	 * Parse a Rust doc page and extract relevant content
	 */
	private _parseDocPage(html: string, url: string): FetchedDocContent | null {
		// Determine page type from URL
		if (url.includes("#method.")) {
			return this._parseMethodDoc(html, url);
		} else if (url.includes("/struct.") || url.includes("/enum.") || url.includes("/trait.")) {
			return this._parseTypeDoc(html, url);
		} else if (url.includes("/macro.")) {
			return this._parseMacroDoc(html, url);
		} else if (url.includes("/keyword.")) {
			return this._parseKeywordDoc(html, url);
		}

		// Generic parsing
		return this._parseGenericDoc(html, url);
	}

	/**
	 * Parse method documentation (e.g., Iterator::for_each)
	 */
	private _parseMethodDoc(html: string, url: string): FetchedDocContent | null {
		const methodName = url.split("#method.")[1];
		if (!methodName) {
			return null;
		}

		// Find the method section
		// Look for the method anchor and extract content after it
		const methodIdPattern = new RegExp(`id="method\\.${methodName}"`, "i");
		const methodMatch = html.match(methodIdPattern);

		if (!methodMatch) {
			return this._parseGenericDoc(html, url);
		}

		// Extract signature - look for <pre class="rust item-decl">
		let signature = "";
		const signatureMatch = html.match(
			new RegExp(
				`method\\.${methodName}[^]*?<pre[^>]*class="[^"]*rust[^"]*"[^>]*>([^<]+)</pre>`,
				"i",
			),
		);
		if (signatureMatch) {
			signature = this._cleanHtml(signatureMatch[1]);
		}

		// Extract description - look for docblock content after the method
		let description = "";
		const methodIndex = html.indexOf(`id="method.${methodName}"`);
		if (methodIndex !== -1) {
			// Find the docblock after this method
			const afterMethod = html.substring(methodIndex, methodIndex + 5000);
			const docBlockMatch = afterMethod.match(/<div class="docblock">([^]*?)<\/div>/i);
			if (docBlockMatch) {
				description = this._cleanHtml(docBlockMatch[1]);
				// Get first 2-3 sentences for conciseness
				description = this._truncateToSentences(description, 3);
			}
		}

		// Extract code examples
		const examples = this._extractCodeExamples(html, methodIndex);

		return {
			title: methodName,
			description: description || `Documentation for ${methodName}`,
			signature,
			examples,
			sourceUrl: url,
			fetchedAt: new Date(),
		};
	}

	/**
	 * Parse type documentation (struct, enum, trait)
	 */
	private _parseTypeDoc(html: string, url: string): FetchedDocContent | null {
		// Extract type name from URL
		const typeMatch = url.match(/\/(struct|enum|trait)\.(\w+)\.html/);
		const typeName = typeMatch ? typeMatch[2] : "Type";

		// Extract main description
		let description = "";
		const mainDocMatch =
			html.match(/<div class="docblock item-decl">([^]*?)<\/div>/i) ||
			html.match(/<section[^>]*class="[^"]*docblock[^"]*"[^>]*>([^]*?)<\/section>/i);
		if (mainDocMatch) {
			description = this._cleanHtml(mainDocMatch[1]);
			description = this._truncateToSentences(description, 3);
		}

		const examples = this._extractCodeExamples(html, 0);

		return {
			title: typeName,
			description: description || `Documentation for ${typeName}`,
			examples,
			sourceUrl: url,
			fetchedAt: new Date(),
		};
	}

	/**
	 * Parse macro documentation
	 */
	private _parseMacroDoc(html: string, url: string): FetchedDocContent | null {
		const macroMatch = url.match(/macro\.(\w+)\.html/);
		const macroName = macroMatch ? macroMatch[1] : "macro";

		let description = "";
		const docMatch = html.match(/<div class="docblock">([^]*?)<\/div>/i);
		if (docMatch) {
			description = this._cleanHtml(docMatch[1]);
			description = this._truncateToSentences(description, 3);
		}

		const examples = this._extractCodeExamples(html, 0);

		return {
			title: `${macroName}!`,
			description: description || `Documentation for ${macroName}! macro`,
			examples,
			sourceUrl: url,
			fetchedAt: new Date(),
		};
	}

	/**
	 * Parse keyword documentation
	 */
	private _parseKeywordDoc(html: string, url: string): FetchedDocContent | null {
		const keywordMatch = url.match(/keyword\.(\w+)\.html/);
		const keyword = keywordMatch ? keywordMatch[1] : "keyword";

		let description = "";
		const docMatch = html.match(/<div class="docblock">([^]*?)<\/div>/i);
		if (docMatch) {
			description = this._cleanHtml(docMatch[1]);
			description = this._truncateToSentences(description, 3);
		}

		const examples = this._extractCodeExamples(html, 0);

		return {
			title: keyword,
			description: description || `Documentation for the ${keyword} keyword`,
			examples,
			sourceUrl: url,
			fetchedAt: new Date(),
		};
	}

	/**
	 * Generic doc parsing fallback
	 */
	private _parseGenericDoc(html: string, url: string): FetchedDocContent | null {
		// Try to get the page title
		let title = "Rust Documentation";
		const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
		if (titleMatch) {
			title = this._cleanHtml(titleMatch[1]).split(" - ")[0];
		}

		// Get first docblock
		let description = "";
		const docMatch = html.match(/<div class="docblock">([^]*?)<\/div>/i);
		if (docMatch) {
			description = this._cleanHtml(docMatch[1]);
			description = this._truncateToSentences(description, 3);
		}

		const examples = this._extractCodeExamples(html, 0);

		return {
			title,
			description: description || "See official documentation for details.",
			examples,
			sourceUrl: url,
			fetchedAt: new Date(),
		};
	}

	/**
	 * Extract code examples from HTML
	 */
	private _extractCodeExamples(html: string, startIndex: number): string[] {
		const examples: string[] = [];
		const relevantHtml = html.substring(startIndex);

		// Look for rust code blocks
		const codeBlockRegex =
			/<pre[^>]*class="[^"]*rust[^"]*"[^>]*><code[^>]*>([^]*?)<\/code><\/pre>/gi;
		let match;
		let count = 0;

		while ((match = codeBlockRegex.exec(relevantHtml)) !== null && count < 3) {
			const code = this._cleanHtml(match[1]);
			if (code.length > 20 && code.length < 1000) {
				// Skip tiny or huge examples
				examples.push(code);
				count++;
			}
		}

		return examples;
	}

	/**
	 * Clean HTML tags and decode entities
	 */
	private _cleanHtml(html: string): string {
		return (
			html
				// Remove HTML tags
				.replace(/<[^>]+>/g, "")
				// Decode common HTML entities
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&#39;/g, "'")
				.replace(/&nbsp;/g, " ")
				.trim()
		);
	}

	/**
	 * Truncate text to a certain number of sentences
	 */
	private _truncateToSentences(text: string, maxSentences: number): string {
		const sentences = text.match(/[^.!?]+[.!?]+/g);
		if (!sentences) {
			return text;
		}

		return sentences.slice(0, maxSentences).join(" ").trim();
	}

	/**
	 * Build the doc URL for common Rust items
	 */
	static buildDocUrl(item: string): string | null {
		// Handle common patterns
		const patterns: Record<string, string> = {
			// Iterator methods
			for_each: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.for_each",
			map: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.map",
			filter: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.filter",
			fold: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.fold",
			collect: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.collect",
			next: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#tymethod.next",
			peekable: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.peekable",
			enumerate: "https://doc.rust-lang.org/std/iter/trait.Iterator.html#method.enumerate",
			iter: "https://doc.rust-lang.org/std/iter/trait.IntoIterator.html",
			into_iter: "https://doc.rust-lang.org/std/iter/trait.IntoIterator.html",

			// Option/Result
			unwrap: "https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap",
			expect: "https://doc.rust-lang.org/std/option/enum.Option.html#method.expect",
			unwrap_or: "https://doc.rust-lang.org/std/option/enum.Option.html#method.unwrap_or",
			ok_or: "https://doc.rust-lang.org/std/option/enum.Option.html#method.ok_or",
			Option: "https://doc.rust-lang.org/std/option/enum.Option.html",
			Result: "https://doc.rust-lang.org/std/result/enum.Result.html",
			Some: "https://doc.rust-lang.org/std/option/enum.Option.html#variant.Some",
			None: "https://doc.rust-lang.org/std/option/enum.Option.html#variant.None",
			Ok: "https://doc.rust-lang.org/std/result/enum.Result.html#variant.Ok",
			Err: "https://doc.rust-lang.org/std/result/enum.Result.html#variant.Err",

			// Types
			String: "https://doc.rust-lang.org/std/string/struct.String.html",
			str: "https://doc.rust-lang.org/std/primitive.str.html",
			Vec: "https://doc.rust-lang.org/std/vec/struct.Vec.html",
			HashMap: "https://doc.rust-lang.org/std/collections/struct.HashMap.html",
			HashSet: "https://doc.rust-lang.org/std/collections/struct.HashSet.html",
			Box: "https://doc.rust-lang.org/std/boxed/struct.Box.html",
			Rc: "https://doc.rust-lang.org/std/rc/struct.Rc.html",
			Arc: "https://doc.rust-lang.org/std/sync/struct.Arc.html",
			RefCell: "https://doc.rust-lang.org/std/cell/struct.RefCell.html",
			Cell: "https://doc.rust-lang.org/std/cell/struct.Cell.html",
			Cow: "https://doc.rust-lang.org/std/borrow/enum.Cow.html",

			// Traits
			Clone: "https://doc.rust-lang.org/std/clone/trait.Clone.html",
			Copy: "https://doc.rust-lang.org/std/marker/trait.Copy.html",
			Drop: "https://doc.rust-lang.org/std/ops/trait.Drop.html",
			Iterator: "https://doc.rust-lang.org/std/iter/trait.Iterator.html",
			IntoIterator: "https://doc.rust-lang.org/std/iter/trait.IntoIterator.html",
			From: "https://doc.rust-lang.org/std/convert/trait.From.html",
			Into: "https://doc.rust-lang.org/std/convert/trait.Into.html",
			AsRef: "https://doc.rust-lang.org/std/convert/trait.AsRef.html",
			Deref: "https://doc.rust-lang.org/std/ops/trait.Deref.html",
			Display: "https://doc.rust-lang.org/std/fmt/trait.Display.html",
			Debug: "https://doc.rust-lang.org/std/fmt/trait.Debug.html",
			Default: "https://doc.rust-lang.org/std/default/trait.Default.html",

			// Keywords
			match: "https://doc.rust-lang.org/std/keyword.match.html",
			"if let": "https://doc.rust-lang.org/std/keyword.if.html",
			"while let": "https://doc.rust-lang.org/std/keyword.while.html",
			loop: "https://doc.rust-lang.org/std/keyword.loop.html",
			for: "https://doc.rust-lang.org/std/keyword.for.html",
			impl: "https://doc.rust-lang.org/std/keyword.impl.html",
			trait: "https://doc.rust-lang.org/std/keyword.trait.html",
			struct: "https://doc.rust-lang.org/std/keyword.struct.html",
			enum: "https://doc.rust-lang.org/std/keyword.enum.html",
			mod: "https://doc.rust-lang.org/std/keyword.mod.html",
			use: "https://doc.rust-lang.org/std/keyword.use.html",
			pub: "https://doc.rust-lang.org/std/keyword.pub.html",
			mut: "https://doc.rust-lang.org/std/keyword.mut.html",
			ref: "https://doc.rust-lang.org/std/keyword.ref.html",
			self: "https://doc.rust-lang.org/std/keyword.self.html",
			Self: "https://doc.rust-lang.org/std/keyword.SelfTy.html",
			dyn: "https://doc.rust-lang.org/std/keyword.dyn.html",
			async: "https://doc.rust-lang.org/std/keyword.async.html",
			await: "https://doc.rust-lang.org/std/keyword.await.html",

			// Macros
			println: "https://doc.rust-lang.org/std/macro.println.html",
			format: "https://doc.rust-lang.org/std/macro.format.html",
			vec: "https://doc.rust-lang.org/std/macro.vec.html",
			panic: "https://doc.rust-lang.org/std/macro.panic.html",
			assert: "https://doc.rust-lang.org/std/macro.assert.html",
			derive: "https://doc.rust-lang.org/reference/attributes/derive.html",
		};

		// Direct match
		if (patterns[item]) {
			return patterns[item];
		}

		// Try without special characters
		const cleaned = item.replace(/[^a-zA-Z_]/g, "");
		if (patterns[cleaned]) {
			return patterns[cleaned];
		}

		return null;
	}
}

// Singleton instance
export const rustDocsFetcher = new RustDocsFetcher();
