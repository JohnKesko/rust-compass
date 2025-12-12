import * as vscode from 'vscode';

export interface SimplifiedExplanation {
    simple: string;          // ELI5 version
    oneLineSummary: string;  // Very short summary
    keyPoints: string[];     // Bullet points
    gotchas: string[];       // Common mistakes/warnings
}

/**
 * Uses VS Code's Language Model API (Copilot) to simplify technical explanations
 */
export class ExplanationSimplifier {
    private cache: Map<string, SimplifiedExplanation> = new Map();

    /**
     * Simplify a technical explanation for beginners
     */
    async simplify(
        term: string,
        officialDescription: string,
        context?: string
    ): Promise<SimplifiedExplanation | null> {
        // Check cache first
        const cacheKey = `${term}:${officialDescription.substring(0, 100)}`;
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            // Get available language models
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot',
                family: 'gpt-4o'
            });

            if (models.length === 0) {
                // Try any available model
                const anyModels = await vscode.lm.selectChatModels();
                if (anyModels.length === 0) {
                    console.log('No language models available');
                    return null;
                }
                models.push(anyModels[0]);
            }

            const model = models[0];

            const prompt = this._buildPrompt(term, officialDescription, context);

            const messages = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

            // Collect the response
            let responseText = '';
            for await (const chunk of response.text) {
                responseText += chunk;
            }

            const result = this._parseResponse(responseText, term, officialDescription);

            // Cache the result
            this.cache.set(cacheKey, result);

            return result;
        } catch (error) {
            console.error('Failed to simplify explanation:', error);
            return null;
        }
    }

    /**
     * Build the prompt for the LLM
     */
    private _buildPrompt(term: string, officialDescription: string, context?: string): string {
        return `You are helping a beginner learn Rust. Simplify this official documentation into beginner-friendly language.

RUST TERM: ${term}

OFFICIAL DOCUMENTATION:
${officialDescription}

${context ? `CONTEXT: The user encountered this while ${context}` : ''}

Respond in this EXACT JSON format (no markdown, just JSON):
{
    "simple": "A simple 1-2 sentence explanation a beginner can understand. Avoid jargon. Use analogies if helpful.",
    "oneLineSummary": "One very short sentence (under 10 words) saying what this does.",
    "keyPoints": ["Key point 1", "Key point 2", "Key point 3"],
    "gotchas": ["Common mistake or warning 1", "Common mistake or warning 2"]
}

Keep it friendly and encouraging. Focus on WHEN to use this, not just WHAT it does.`;
    }

    /**
     * Parse the LLM response
     */
    private _parseResponse(response: string, term: string, fallbackDescription: string): SimplifiedExplanation {
        try {
            // Try to extract JSON from the response
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    simple: parsed.simple || fallbackDescription,
                    oneLineSummary: parsed.oneLineSummary || term,
                    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints : [],
                    gotchas: Array.isArray(parsed.gotchas) ? parsed.gotchas : []
                };
            }
        } catch (e) {
            console.error('Failed to parse LLM response:', e);
        }

        // Fallback
        return {
            simple: fallbackDescription,
            oneLineSummary: term,
            keyPoints: [],
            gotchas: []
        };
    }

    /**
     * Quick check if LLM is available
     */
    async isAvailable(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels();
            return models.length > 0;
        } catch {
            return false;
        }
    }
}

// Singleton instance
export const explanationSimplifier = new ExplanationSimplifier();
