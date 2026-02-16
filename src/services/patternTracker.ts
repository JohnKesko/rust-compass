import * as vscode from "vscode";

/**
 * Tracks how often patterns are encountered
 */
export interface PatternStats {
	ruleId: string;
	count: number;
	firstSeen: number; // timestamp
	lastSeen: number; // timestamp
	dismissed: boolean;
}

/**
 * Session stats for displaying
 */
export interface SessionSummary {
	totalPatterns: number;
	topPatterns: { ruleId: string; count: number; title?: string }[];
	sessionStart: number;
	uniquePatterns: number;
}

/**
 * Service to track pattern frequency and learning progress
 */
export class PatternTracker implements vscode.Disposable {
	private static instance: PatternTracker;
	private stats: Map<string, PatternStats> = new Map();
	private sessionStart: number;
	private globalState: vscode.Memento | null = null;

	// Event emitter for milestone notifications
	private _onMilestone = new vscode.EventEmitter<{
		ruleId: string;
		count: number;
		message: string;
	}>();
	public readonly onMilestone = this._onMilestone.event;

	private constructor() {
		this.sessionStart = Date.now();
	}

	public static getInstance(): PatternTracker {
		if (!PatternTracker.instance) {
			PatternTracker.instance = new PatternTracker();
		}
		return PatternTracker.instance;
	}

	/**
	 * Initialize with VS Code global state for persistence
	 */
	public initialize(globalState: vscode.Memento): void {
		this.globalState = globalState;
		this.loadStats();
	}

	/**
	 * Record that a pattern was encountered
	 */
	public recordPattern(ruleId: string): void {
		const now = Date.now();
		const existing = this.stats.get(ruleId);

		if (existing) {
			existing.count++;
			existing.lastSeen = now;
			this.stats.set(ruleId, existing);
		} else {
			this.stats.set(ruleId, {
				ruleId,
				count: 1,
				firstSeen: now,
				lastSeen: now,
				dismissed: false,
			});
		}

		// Check for milestones
		this.checkMilestones(ruleId);

		// Save periodically
		this.saveStats();
	}

	/**
	 * Get stats for a specific rule
	 */
	public getStats(ruleId: string): PatternStats | null {
		return this.stats.get(ruleId) || null;
	}

	/**
	 * Get session summary
	 */
	public getSessionSummary(): SessionSummary {
		const allStats = Array.from(this.stats.values());
		const sessionStats = allStats.filter((s) => s.lastSeen >= this.sessionStart);

		const sortedByCount = [...sessionStats].sort((a, b) => b.count - a.count);

		return {
			totalPatterns: sessionStats.reduce((sum, s) => sum + s.count, 0),
			topPatterns: sortedByCount.slice(0, 5).map((s) => ({
				ruleId: s.ruleId,
				count: s.count,
			})),
			sessionStart: this.sessionStart,
			uniquePatterns: sessionStats.length,
		};
	}

	/**
	 * Get all-time summary
	 */
	public getAllTimeSummary(): SessionSummary {
		const allStats = Array.from(this.stats.values());
		const sortedByCount = [...allStats].sort((a, b) => b.count - a.count);

		return {
			totalPatterns: allStats.reduce((sum, s) => sum + s.count, 0),
			topPatterns: sortedByCount.slice(0, 5).map((s) => ({
				ruleId: s.ruleId,
				count: s.count,
			})),
			sessionStart: Math.min(...allStats.map((s) => s.firstSeen)),
			uniquePatterns: allStats.length,
		};
	}

	/**
	 * Get patterns that might be worth learning (seen frequently but not dismissed)
	 */
	public getSuggestedLearning(): PatternStats[] {
		const threshold = 5; // Suggest learning after seeing 5+ times
		return Array.from(this.stats.values())
			.filter((s) => s.count >= threshold && !s.dismissed)
			.sort((a, b) => b.count - a.count);
	}

	/**
	 * Mark a pattern as "learned" (dismissed)
	 */
	public markAsLearned(ruleId: string): void {
		const stats = this.stats.get(ruleId);
		if (stats) {
			stats.dismissed = true;
			this.stats.set(ruleId, stats);
			this.saveStats();
		}
	}

	/**
	 * Get insight message for a pattern
	 */
	public getInsightMessage(ruleId: string): string | null {
		const stats = this.stats.get(ruleId);
		if (!stats) {
			return null;
		}

		if (stats.count === 1) {
			return "✨ First time seeing this pattern!";
		} else if (stats.count === 5) {
			return "📈 You've seen this 5 times — getting familiar?";
		} else if (stats.count === 10) {
			return "🎯 10 times! Consider marking as learned if you've got it.";
		} else if (stats.count >= 20 && !stats.dismissed) {
			return `💪 ${stats.count} times! You might be ready to turn off this hint.`;
		} else if (stats.count > 5) {
			return `Seen ${stats.count} times`;
		}

		return null;
	}

	/**
	 * Check and emit milestone notifications
	 */
	private checkMilestones(ruleId: string): void {
		const stats = this.stats.get(ruleId);
		if (!stats) {
			return;
		}

		const milestones = [5, 10, 25, 50, 100];
		if (milestones.includes(stats.count)) {
			let message: string;
			switch (stats.count) {
				case 5:
					message = `You've encountered this pattern 5 times. Getting familiar?`;
					break;
				case 10:
					message = `10 times! You might be ready to hide this hint.`;
					break;
				case 25:
					message = `25 times! Consider this pattern mastered?`;
					break;
				case 50:
					message = `50 times! You're definitely familiar with this one.`;
					break;
				case 100:
					message = `100 times! 🎉 You're a pro at this pattern!`;
					break;
				default:
					message = `Milestone: ${stats.count} occurrences`;
			}

			this._onMilestone.fire({ ruleId, count: stats.count, message });
		}
	}

	/**
	 * Load stats from persistent storage
	 */
	private loadStats(): void {
		if (!this.globalState) {
			return;
		}

		const saved = this.globalState.get<Record<string, PatternStats>>("patternStats");
		if (saved) {
			this.stats = new Map(Object.entries(saved));
		}
	}

	/**
	 * Save stats to persistent storage
	 */
	private saveStats(): void {
		if (!this.globalState) {
			return;
		}

		const obj: Record<string, PatternStats> = {};
		this.stats.forEach((value, key) => {
			obj[key] = value;
		});

		this.globalState.update("patternStats", obj);
	}

	/**
	 * Reset all stats
	 */
	public resetStats(): void {
		this.stats.clear();
		this.saveStats();
	}

	dispose(): void {
		this._onMilestone.dispose();
	}
}
