import * as vscode from 'vscode';

/**
 * Detected project/code intent
 */
export interface CodeIntent {
    // What the user is building
    projectType: ProjectType | null;
    // Current file's purpose
    fileIntent: FileIntent | null;
    // What the current function/block is doing
    blockIntent: BlockIntent | null;
    // Confidence 0-1
    confidence: number;
}

export type ProjectType =
    | 'parser'
    | 'lexer'
    | 'compiler'
    | 'cli'
    | 'web-server'
    | 'game'
    | 'library'
    | 'unknown';

export type FileIntent =
    | 'lexer'
    | 'parser'
    | 'ast'
    | 'tokenizer'
    | 'error-handling'
    | 'data-model'
    | 'main-entry'
    | 'tests'
    | 'utils'
    | 'unknown';

export type BlockIntent =
    | 'iterating-chars'
    | 'iterating-tokens'
    | 'building-string'
    | 'matching-patterns'
    | 'error-handling'
    | 'parsing-structure'
    | 'state-machine'
    | 'unknown';

/**
 * Teachable moment - when we detect something worth hinting about
 */
export interface TeachableMoment {
    range: vscode.Range;
    intent: string;
    suggestion: string;
    ruleId: string;
    severity: 'hint' | 'info';
    // Why we're showing this, based on what user is doing
    contextReason: string;
}

/**
 * Analyzes code to understand what the user is trying to do
 */
export class IntentAnalyzer {
    private projectTypeCache: ProjectType | null = null;
    private lastAnalysis: Map<string, CodeIntent> = new Map();

    /**
     * Analyze the entire workspace to understand project type
     */
    async analyzeProject(workspaceFolder: vscode.Uri): Promise<ProjectType> {
        if (this.projectTypeCache) {
            return this.projectTypeCache;
        }

        // Check Cargo.toml for project name hints
        const cargoPath = vscode.Uri.joinPath(workspaceFolder, 'Cargo.toml');
        try {
            const cargoContent = await vscode.workspace.fs.readFile(cargoPath);
            const cargoText = Buffer.from(cargoContent).toString('utf8');

            const projectType = this.inferProjectTypeFromCargo(cargoText);
            if (projectType !== 'unknown') {
                this.projectTypeCache = projectType;
                return projectType;
            }
        } catch {
            // No Cargo.toml
        }

        // Check file names in src/
        const srcFiles = await vscode.workspace.findFiles('src/**/*.rs', null, 50);
        const fileNames = srcFiles.map(f => f.path.split('/').pop()?.toLowerCase() || '');

        this.projectTypeCache = this.inferProjectTypeFromFiles(fileNames);
        return this.projectTypeCache;
    }

    private inferProjectTypeFromCargo(content: string): ProjectType {
        const nameLower = content.toLowerCase();

        // Check package name
        const nameMatch = nameLower.match(/name\s*=\s*"([^"]+)"/);
        if (nameMatch) {
            const name = nameMatch[1];
            if (name.includes('parser') || name.includes('parse')) return 'parser';
            if (name.includes('lexer') || name.includes('lex')) return 'lexer';
            if (name.includes('compiler') || name.includes('lang')) return 'compiler';
            if (name.includes('cli') || name.includes('cmd')) return 'cli';
            if (name.includes('server') || name.includes('api')) return 'web-server';
        }

        // Check dependencies
        if (nameLower.includes('nom') || nameLower.includes('pest') || nameLower.includes('lalrpop')) {
            return 'parser';
        }
        if (nameLower.includes('clap') || nameLower.includes('structopt')) {
            return 'cli';
        }
        if (nameLower.includes('actix') || nameLower.includes('axum') || nameLower.includes('rocket') || nameLower.includes('warp')) {
            return 'web-server';
        }
        if (nameLower.includes('bevy') || nameLower.includes('ggez') || nameLower.includes('macroquad')) {
            return 'game';
        }

        return 'unknown';
    }

    private inferProjectTypeFromFiles(fileNames: string[]): ProjectType {
        const hasLexer = fileNames.some(f => f.includes('lexer') || f.includes('lex') || f.includes('tokenizer') || f.includes('scanner'));
        const hasParser = fileNames.some(f => f.includes('parser') || f.includes('parse'));
        const hasAst = fileNames.some(f => f.includes('ast') || f.includes('node') || f.includes('tree') || f.includes('syntax'));

        if (hasLexer && hasParser) return 'compiler';
        if (hasLexer) return 'lexer';
        if (hasParser) return 'parser';

        return 'unknown';
    }

    /**
     * Analyze a single file to understand its purpose
     */
    analyzeFile(document: vscode.TextDocument): FileIntent {
        const fileName = document.fileName.toLowerCase();
        const content = document.getText().toLowerCase();

        // File name hints
        if (fileName.includes('lexer') || fileName.includes('scanner') || fileName.includes('tokenizer')) {
            return 'lexer';
        }
        if (fileName.includes('parser') || fileName.includes('parse')) {
            return 'parser';
        }
        if (fileName.includes('ast') || fileName.includes('node') || fileName.includes('tree')) {
            return 'ast';
        }
        if (fileName.includes('token')) {
            return 'tokenizer';
        }
        if (fileName.includes('error')) {
            return 'error-handling';
        }
        if (fileName.includes('main.rs')) {
            return 'main-entry';
        }
        if (fileName.includes('test') || fileName.includes('_test') || fileName.includes('tests')) {
            return 'tests';
        }
        if (fileName.includes('util') || fileName.includes('helper')) {
            return 'utils';
        }

        // Content hints
        if (content.includes('struct token') || content.includes('enum token') ||
            content.includes('tokenize') || content.includes('lex(')) {
            return 'lexer';
        }
        if (content.includes('parse(') || content.includes('struct parser') ||
            content.includes('expect_token') || content.includes('peek_token')) {
            return 'parser';
        }
        if (content.includes('enum expr') || content.includes('enum stmt') ||
            content.includes('struct ast') || content.includes('node')) {
            return 'ast';
        }

        return 'unknown';
    }

    /**
     * Analyze a specific code block/function to understand what it's doing
     */
    analyzeBlock(document: vscode.TextDocument, position: vscode.Position): BlockIntent {
        // Get the surrounding function/block
        const text = document.getText();
        const offset = document.offsetAt(position);

        // Find the function we're in
        const beforeCursor = text.substring(0, offset);
        const fnMatch = beforeCursor.match(/fn\s+(\w+)[^{]*\{[^}]*$/s);

        if (!fnMatch) {
            return 'unknown';
        }

        // Get function body (approximate - find matching brace)
        const fnStart = beforeCursor.lastIndexOf(fnMatch[0]);
        const fnName = fnMatch[1].toLowerCase();

        // Get a reasonable chunk around the cursor
        const contextStart = Math.max(0, offset - 500);
        const contextEnd = Math.min(text.length, offset + 500);
        const context = text.substring(contextStart, contextEnd).toLowerCase();

        // Detect patterns
        if (context.includes('.chars()') || context.includes('.bytes()') ||
            context.includes('char_indices') || (context.includes('.next()') && context.includes('char'))) {
            return 'iterating-chars';
        }

        if (context.includes('tokens.') || context.includes('token_iter') ||
            fnName.includes('token') || context.includes('.peek()') && context.includes('token')) {
            return 'iterating-tokens';
        }

        if (context.includes('string::new()') || context.includes('.push_str') ||
            context.includes('.push(') || context.includes('format!')) {
            return 'building-string';
        }

        if (context.includes('match ') || context.includes('if let some') ||
            context.includes('if let ok')) {
            return 'matching-patterns';
        }

        if (context.includes('result<') || context.includes('option<') ||
            context.includes('.ok_or') || context.includes('?;')) {
            return 'error-handling';
        }

        if (context.includes('state') || context.includes('enum ') && context.includes('mode')) {
            return 'state-machine';
        }

        return 'unknown';
    }

    /**
     * Find teachable moments in a document based on intent
     */
    findTeachableMoments(document: vscode.TextDocument): TeachableMoment[] {
        const moments: TeachableMoment[] = [];
        const text = document.getText();
        const fileIntent = this.analyzeFile(document);

        // Pattern: Using .next() in a lexer/parser without peekable
        if (fileIntent === 'lexer' || fileIntent === 'parser') {
            // Find .chars().next() patterns that could use peekable
            const charsNextPattern = /\.chars\(\)(?!\.peekable)/g;
            let match;
            while ((match = charsNextPattern.exec(text)) !== null) {
                // Check if there's a .next() nearby but no .peekable()
                const after = text.substring(match.index, Math.min(text.length, match.index + 200));
                if (after.includes('.next()') && !after.includes('.peekable()')) {
                    const pos = document.positionAt(match.index);
                    moments.push({
                        range: new vscode.Range(pos, pos.translate(0, match[0].length)),
                        intent: 'iterating-chars',
                        suggestion: 'Building a lexer? Consider .peekable() to look ahead without consuming',
                        ruleId: 'iterator-next-without-peekable',
                        severity: 'hint',
                        contextReason: `Detected lexer pattern: iterating chars with .next()`
                    });
                }
            }

            // Find iterator patterns that might need peek
            const iterNextPattern = /let\s+\w+\s*=\s*\w+\.next\(\)/g;
            while ((match = iterNextPattern.exec(text)) !== null) {
                const lineStart = text.lastIndexOf('\n', match.index) + 1;
                const lineEnd = text.indexOf('\n', match.index);
                const line = text.substring(lineStart, lineEnd > 0 ? lineEnd : text.length);

                // Check if we're in a loop or conditional that suggests looking ahead
                const before = text.substring(Math.max(0, match.index - 100), match.index);
                if (before.includes('while') || before.includes('loop') || before.includes('if ')) {
                    const pos = document.positionAt(match.index);
                    moments.push({
                        range: new vscode.Range(pos, pos.translate(0, match[0].length)),
                        intent: 'looking-ahead',
                        suggestion: 'Need to look ahead? .peek() lets you see without consuming',
                        ruleId: 'iterator-next-without-peekable',
                        severity: 'hint',
                        contextReason: 'Using .next() in a loop - might need to peek first'
                    });
                }
            }
        }

        // Pattern: Excessive cloning in any file
        const clonePattern = /\.clone\(\)/g;
        let cloneCount = 0;
        let lastClonePos: vscode.Position | null = null;
        let match;
        while ((match = clonePattern.exec(text)) !== null) {
            cloneCount++;
            lastClonePos = document.positionAt(match.index);
        }
        if (cloneCount >= 3 && lastClonePos) {
            // Find the last clone and add a hint there
            const lastMatch = text.lastIndexOf('.clone()');
            const pos = document.positionAt(lastMatch);
            moments.push({
                range: new vscode.Range(pos, pos.translate(0, 8)),
                intent: 'avoiding-borrow-checker',
                suggestion: `Found ${cloneCount} clones in this file. Some might be avoidable with borrowing`,
                ruleId: 'excessive-clone',
                severity: 'info',
                contextReason: 'Multiple .clone() calls detected'
            });
        }

        // Pattern: .unwrap() in non-test files
        if (!document.fileName.includes('test')) {
            const unwrapPattern = /\.unwrap\(\)/g;
            let unwrapCount = 0;
            while ((match = unwrapPattern.exec(text)) !== null) {
                unwrapCount++;
                if (unwrapCount >= 2) {
                    const pos = document.positionAt(match.index);
                    moments.push({
                        range: new vscode.Range(pos, pos.translate(0, 9)),
                        intent: 'error-handling',
                        suggestion: 'Multiple .unwrap() calls - consider proper error handling with ? or match',
                        ruleId: 'unwrap-usage',
                        severity: 'hint',
                        contextReason: 'Production code with unwrap() calls'
                    });
                    break; // Only one hint for this
                }
            }
        }

        // Pattern: String vs &str confusion - functions taking String instead of &str
        const fnStringParam = /fn\s+\w+\s*\([^)]*:\s*String(?!\s*,|\s*\))/g;
        while ((match = fnStringParam.exec(text)) !== null) {
            const pos = document.positionAt(match.index);
            moments.push({
                range: new vscode.Range(pos, pos.translate(0, match[0].length)),
                intent: 'api-design',
                suggestion: 'Function takes String - consider &str for more flexibility',
                ruleId: 'string-vs-str',
                severity: 'hint',
                contextReason: 'Function parameter uses String instead of &str'
            });
        }

        return moments;
    }

    /**
     * Get full analysis for current position
     */
    async getFullAnalysis(document: vscode.TextDocument, position: vscode.Position): Promise<CodeIntent> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        let projectType: ProjectType = 'unknown';

        if (workspaceFolder) {
            projectType = await this.analyzeProject(workspaceFolder.uri);
        }

        return {
            projectType,
            fileIntent: this.analyzeFile(document),
            blockIntent: this.analyzeBlock(document, position),
            confidence: 0.7 // TODO: Calculate based on matches
        };
    }

    /**
     * Clear caches (e.g., when project changes)
     */
    clearCache() {
        this.projectTypeCache = null;
        this.lastAnalysis.clear();
    }
}

// Singleton
export const intentAnalyzer = new IntentAnalyzer();
