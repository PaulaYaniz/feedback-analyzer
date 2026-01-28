/**
 * Feedback Aggregation and Analysis Tool
 * Cloudflare PM Intern Assignment
 *
 * This Worker provides a complete feedback management system with:
 * - Feedback submission and retrieval (D1 Database)
 * - AI-powered sentiment analysis and theme extraction (Workers AI)
 * - Aggregated analytics with caching (KV)
 * - Web dashboard interface
 */

interface FeedbackEntry {
	id?: number;
	source: string;
	text: string;
	sentiment?: string | null;
	themes?: string | null;
	urgency?: string | null;
	created_at?: string;
}

interface AggregatedStats {
	total: number;
	by_source: Record<string, number>;
	by_sentiment: Record<string, number>;
	by_urgency: Record<string, number>;
	recent_urgent: FeedbackEntry[];
	timestamp: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS headers for API requests
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// Route handling
			if (path === '/' && request.method === 'GET') {
				return new Response(getDashboardHTML(), {
					headers: { 'Content-Type': 'text/html' },
				});
			}

			if (path === '/api/feedback' && request.method === 'GET') {
				return await listFeedback(env, corsHeaders);
			}

			if (path === '/api/feedback' && request.method === 'POST') {
				return await submitFeedback(request, env, corsHeaders);
			}

			if (path === '/api/stats' && request.method === 'GET') {
				return await getStats(env, corsHeaders);
			}

			if (path.startsWith('/api/analyze/') && request.method === 'POST') {
				const id = parseInt(path.split('/').pop() || '0');
				return await analyzeFeedback(id, env, corsHeaders);
			}

			if (path === '/api/analyze-all' && request.method === 'POST') {
				return await analyzeAllFeedback(env, corsHeaders);
			}

			if (path === '/api/insights' && request.method === 'GET') {
				return await getInsights(env, corsHeaders);
			}

			// 404 for unknown routes
			return new Response('Not Found', {
				status: 404,
				headers: corsHeaders
			});

		} catch (error) {
			console.error('Error handling request:', error);
			return new Response(
				JSON.stringify({
					error: 'Internal Server Error',
					message: error instanceof Error ? error.message : 'Unknown error'
				}),
				{
					status: 500,
					headers: { ...corsHeaders, 'Content-Type': 'application/json' }
				}
			);
		}
	},
} satisfies ExportedHandler<Env>;

/**
 * List all feedback entries
 */
async function listFeedback(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100'
	).all();

	return new Response(JSON.stringify(results), {
		headers: { ...corsHeaders, 'Content-Type': 'application/json' },
	});
}

/**
 * Submit new feedback entry
 */
async function submitFeedback(
	request: Request,
	env: Env,
	corsHeaders: Record<string, string>
): Promise<Response> {
	const body = await request.json() as { source: string; text: string };

	if (!body.source || !body.text) {
		return new Response(
			JSON.stringify({ error: 'Missing required fields: source and text' }),
			{ status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
		);
	}

	const result = await env.DB.prepare(
		'INSERT INTO feedback (source, text) VALUES (?, ?) RETURNING *'
	).bind(body.source, body.text).first();

	// Invalidate cache when new feedback is added
	await env.CACHE.delete('stats');

	return new Response(JSON.stringify(result), {
		status: 201,
		headers: { ...corsHeaders, 'Content-Type': 'application/json' },
	});
}

/**
 * Get aggregated statistics with caching
 * Implements Cloudflare KV best practices: cacheTtl for edge caching
 * https://developers.cloudflare.com/kv/api/read-key-value-pairs/#cachettl-parameter
 */
async function getStats(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	// Try to get from cache first with edge caching (Cloudflare best practice)
	// cacheTtl: 60s minimum per docs, reduces cold read latency
	const cached = await env.CACHE.get('stats', { cacheTtl: 60 });
	if (cached) {
		return new Response(cached, {
			headers: {
				...corsHeaders,
				'Content-Type': 'application/json',
				'X-Cache': 'HIT',
				'Cache-Control': 'public, max-age=60' // CDN caching
			},
		});
	}

	// Calculate fresh stats
	const stats: AggregatedStats = {
		total: 0,
		by_source: {},
		by_sentiment: {},
		by_urgency: {},
		recent_urgent: [],
		timestamp: new Date().toISOString()
	};

	// Get total count
	const totalResult = await env.DB.prepare('SELECT COUNT(*) as count FROM feedback').first();
	stats.total = (totalResult as any)?.count || 0;

	// Get counts by source
	const sourceResults = await env.DB.prepare(
		'SELECT source, COUNT(*) as count FROM feedback GROUP BY source'
	).all();
	for (const row of sourceResults.results) {
		const r = row as any;
		stats.by_source[r.source] = r.count;
	}

	// Get counts by sentiment
	const sentimentResults = await env.DB.prepare(
		'SELECT sentiment, COUNT(*) as count FROM feedback WHERE sentiment IS NOT NULL GROUP BY sentiment'
	).all();
	for (const row of sentimentResults.results) {
		const r = row as any;
		if (r.sentiment) {
			stats.by_sentiment[r.sentiment] = r.count;
		}
	}

	// Get counts by urgency
	const urgencyResults = await env.DB.prepare(
		'SELECT urgency, COUNT(*) as count FROM feedback WHERE urgency IS NOT NULL GROUP BY urgency'
	).all();
	for (const row of urgencyResults.results) {
		const r = row as any;
		if (r.urgency) {
			stats.by_urgency[r.urgency] = r.count;
		}
	}

	// Get recent urgent items
	const urgentResults = await env.DB.prepare(
		'SELECT * FROM feedback WHERE urgency = "high" ORDER BY created_at DESC LIMIT 5'
	).all();
	stats.recent_urgent = urgentResults.results as FeedbackEntry[];

	// Cache for 5 minutes with metadata (Cloudflare best practice)
	// Metadata helps track cache freshness and debugging
	const statsJson = JSON.stringify(stats);
	await env.CACHE.put('stats', statsJson, {
		expirationTtl: 300,
		metadata: {
			generated: new Date().toISOString(),
			totalCount: stats.total,
			version: 'v2'
		}
	});

	return new Response(statsJson, {
		headers: {
			...corsHeaders,
			'Content-Type': 'application/json',
			'X-Cache': 'MISS',
			'Cache-Control': 'public, max-age=60'
		},
	});
}

/**
 * Analyze a single feedback entry with Workers AI
 */
async function analyzeFeedback(
	id: number,
	env: Env,
	corsHeaders: Record<string, string>
): Promise<Response> {
	// Get the feedback entry
	const feedback = await env.DB.prepare(
		'SELECT * FROM feedback WHERE id = ?'
	).bind(id).first() as FeedbackEntry | null;

	if (!feedback) {
		return new Response(
			JSON.stringify({ error: 'Feedback not found' }),
			{ status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
		);
	}

	// Analyze with Workers AI
	const analysis = await analyzeWithAI(feedback.text, env);

	// Update the database with analysis results
	await env.DB.prepare(
		'UPDATE feedback SET sentiment = ?, themes = ?, urgency = ? WHERE id = ?'
	).bind(analysis.sentiment, analysis.themes, analysis.urgency, id).run();

	// Invalidate cache
	await env.CACHE.delete('stats');

	return new Response(JSON.stringify({ id, ...analysis }), {
		headers: { ...corsHeaders, 'Content-Type': 'application/json' },
	});
}

/**
 * Analyze all unanalyzed feedback entries with progress updates
 */
async function analyzeAllFeedback(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT * FROM feedback WHERE sentiment IS NULL LIMIT 50'
	).all();

	const analyzed = [];
	const batchSize = 5; // Process in smaller batches for faster perceived performance

	for (let i = 0; i < results.length; i += batchSize) {
		const batch = results.slice(i, i + batchSize);

		// Process batch in parallel
		const batchPromises = (batch as FeedbackEntry[]).map(async (feedback) => {
			const analysis = await analyzeWithAI(feedback.text, env);

			await env.DB.prepare(
				'UPDATE feedback SET sentiment = ?, themes = ?, urgency = ? WHERE id = ?'
			).bind(analysis.sentiment, analysis.themes, analysis.urgency, feedback.id).run();

			return { id: feedback.id, ...analysis };
		});

		const batchResults = await Promise.all(batchPromises);
		analyzed.push(...batchResults);
	}

	// Invalidate cache
	await env.CACHE.delete('stats');
	await env.CACHE.delete('insights');

	return new Response(JSON.stringify({
		analyzed: analyzed.length,
		results: analyzed
	}), {
		headers: { ...corsHeaders, 'Content-Type': 'application/json' },
	});
}

/**
 * Use Workers AI to analyze feedback text - OPTIMIZED FOR SPEED
 */
async function analyzeWithAI(text: string, env: Env): Promise<{
	sentiment: string;
	themes: string;
	urgency: string;
}> {
	// Single combined prompt for faster analysis
	const combinedPrompt = `Analyze this customer feedback and provide sentiment, themes, and urgency.

Feedback: "${text}"

Format your response EXACTLY as:
SENTIMENT: [positive/negative/neutral]
THEMES: [up to 3 from: bug, feature-request, performance, ux, documentation, pricing, security, integration, mobile, accessibility, api, support]
URGENCY: [low/medium/high]

Your analysis:`;

	try {
		const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
			prompt: combinedPrompt,
			max_tokens: 50
		}) as { response: string };

		const result = response.response.trim();

		// Parse response
		const sentimentMatch = result.match(/SENTIMENT:\s*(positive|negative|neutral)/i);
		const themesMatch = result.match(/THEMES:\s*([^\n]+)/i);
		const urgencyMatch = result.match(/URGENCY:\s*(low|medium|high)/i);

		const sentiment = sentimentMatch ? sentimentMatch[1].toLowerCase() : 'neutral';
		const themes = themesMatch ? themesMatch[1].trim() : 'general';
		const urgency = urgencyMatch ? urgencyMatch[1].toLowerCase() : 'medium';

		return {
			sentiment: ['positive', 'negative', 'neutral'].includes(sentiment) ? sentiment : 'neutral',
			themes: themes,
			urgency: ['low', 'medium', 'high'].includes(urgency) ? urgency : 'medium'
		};
	} catch (error) {
		// Fallback if AI fails
		console.error('AI analysis failed:', error);
		return {
			sentiment: 'neutral',
			themes: 'general',
			urgency: 'medium'
		};
	}
}

/**
 * Get PM-focused insights from feedback data
 */
/**
 * Get PM-focused insights from feedback data
 * Implements Cloudflare KV best practices: cacheTtl for edge caching
 */
async function getInsights(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	// Try cache first with edge caching (Cloudflare best practice)
	const cached = await env.CACHE.get('insights', { cacheTtl: 60 });
	if (cached) {
		return new Response(cached, {
			headers: {
				...corsHeaders,
				'Content-Type': 'application/json',
				'X-Cache': 'HIT',
				'Cache-Control': 'public, max-age=60'
			}
		});
	}

	// Get all analyzed feedback
	const { results } = await env.DB.prepare(
		'SELECT * FROM feedback WHERE sentiment IS NOT NULL ORDER BY created_at DESC'
	).all();

	const feedback = results as FeedbackEntry[];

	if (feedback.length === 0) {
		return new Response(JSON.stringify({
			message: 'No analyzed feedback yet. Click "Analyze All Feedback" first.',
			insights: []
		}), {
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	}

	// Calculate insights
	const insights = {
		// Top Priority Issues
		topPriorityIssues: feedback
			.filter(f => f.urgency === 'high' && f.sentiment === 'negative')
			.slice(0, 5)
			.map(f => ({
				text: f.text.substring(0, 100) + '...',
				source: f.source,
				themes: f.themes,
				created_at: f.created_at
			})),

		// Feature Requests by Demand
		topFeatureRequests: feedback
			.filter(f => f.themes?.includes('feature-request'))
			.slice(0, 5)
			.map(f => ({
				text: f.text.substring(0, 100) + '...',
				source: f.source,
				sentiment: f.sentiment
			})),

		// Most Common Pain Points
		painPoints: getPainPoints(feedback),

		// Quick Wins (positive feedback themes to amplify)
		quickWins: feedback
			.filter(f => f.sentiment === 'positive')
			.slice(0, 3)
			.map(f => ({
				text: f.text.substring(0, 100) + '...',
				themes: f.themes,
				source: f.source
			})),

		// Sentiment Trend
		sentimentScore: calculateSentimentScore(feedback),

		// Action Items for PM
		actionItems: generateActionItems(feedback),

		// Theme Distribution
		themeBreakdown: getThemeBreakdown(feedback)
	};

	const insightsJson = JSON.stringify(insights);
	await env.CACHE.put('insights', insightsJson, {
		expirationTtl: 300,
		metadata: {
			generated: new Date().toISOString(),
			feedbackCount: feedback.length,
			criticalIssues: insights.topPriorityIssues.length
		}
	});

	return new Response(insightsJson, {
		headers: {
			...corsHeaders,
			'Content-Type': 'application/json',
			'X-Cache': 'MISS',
			'Cache-Control': 'public, max-age=60'
		}
	});
}

function getPainPoints(feedback: FeedbackEntry[]): { theme: string; count: number; severity: string }[] {
	const themes: Record<string, { count: number; urgency: string[] }> = {};

	feedback
		.filter(f => f.sentiment === 'negative' && f.themes)
		.forEach(f => {
			const themeList = f.themes!.split(',').map(t => t.trim());
			themeList.forEach(theme => {
				if (!themes[theme]) {
					themes[theme] = { count: 0, urgency: [] };
				}
				themes[theme].count++;
				if (f.urgency) themes[theme].urgency.push(f.urgency);
			});
		});

	return Object.entries(themes)
		.map(([theme, data]) => ({
			theme,
			count: data.count,
			severity: data.urgency.filter(u => u === 'high').length > data.count / 2 ? 'high' : 'medium'
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 5);
}

function calculateSentimentScore(feedback: FeedbackEntry[]): number {
	const scores = { positive: 1, neutral: 0, negative: -1 };
	const total = feedback.reduce((sum, f) => {
		return sum + (scores[f.sentiment as keyof typeof scores] || 0);
	}, 0);
	return Math.round((total / feedback.length) * 100);
}

function generateActionItems(feedback: FeedbackEntry[]): string[] {
	const items: string[] = [];

	const highUrgency = feedback.filter(f => f.urgency === 'high').length;
	if (highUrgency > 0) {
		items.push(`🚨 ${highUrgency} high-urgency items need immediate attention`);
	}

	const bugs = feedback.filter(f => f.themes?.includes('bug')).length;
	if (bugs > 5) {
		items.push(`🐛 ${bugs} bug reports - consider allocating sprint capacity for stability work`);
	}

	const featureRequests = feedback.filter(f => f.themes?.includes('feature-request')).length;
	if (featureRequests > 3) {
		items.push(`💡 ${featureRequests} feature requests - prioritize by customer impact and engineering effort`);
	}

	const negative = feedback.filter(f => f.sentiment === 'negative').length;
	const positiveRatio = (feedback.length - negative) / feedback.length;
	if (positiveRatio < 0.5) {
		items.push(`📉 Customer sentiment is trending negative - schedule customer interviews to understand root causes`);
	}

	const performance = feedback.filter(f => f.themes?.includes('performance')).length;
	if (performance > 2) {
		items.push(`⚡ ${performance} performance complaints - run performance audit and set optimization goals`);
	}

	const documentation = feedback.filter(f => f.themes?.includes('documentation')).length;
	if (documentation > 2) {
		items.push(`📚 ${documentation} docs gaps identified - update documentation and consider tutorial videos`);
	}

	if (items.length === 0) {
		items.push(`✅ No critical issues detected - focus on feature development and user growth`);
	}

	return items;
}

function getThemeBreakdown(feedback: FeedbackEntry[]): { theme: string; count: number; sentiment: string }[] {
	const themes: Record<string, { count: number; negative: number }> = {};

	feedback.forEach(f => {
		if (f.themes) {
			const themeList = f.themes.split(',').map(t => t.trim());
			themeList.forEach(theme => {
				if (!themes[theme]) {
					themes[theme] = { count: 0, negative: 0 };
				}
				themes[theme].count++;
				if (f.sentiment === 'negative') themes[theme].negative++;
			});
		}
	});

	return Object.entries(themes)
		.map(([theme, data]) => ({
			theme,
			count: data.count,
			sentiment: data.negative > data.count / 2 ? 'negative' : 'positive'
		}))
		.sort((a, b) => b.count - a.count)
		.slice(0, 10);
}

/**
 * Generate PM-focused dashboard HTML
 */
function getDashboardHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>PM Feedback Dashboard - Actionable Insights</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			background: #f5f5f5;
			color: #333;
			padding: 20px;
		}
		.container { max-width: 1200px; margin: 0 auto; }
		header {
			background: linear-gradient(135deg, #f68a1e 0%, #f6821f 100%);
			color: white;
			padding: 30px;
			border-radius: 10px;
			margin-bottom: 30px;
			box-shadow: 0 4px 6px rgba(0,0,0,0.1);
		}
		h1 { font-size: 28px; margin-bottom: 5px; }
		.subtitle { opacity: 0.9; font-size: 14px; }
		.stats-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
			gap: 20px;
			margin-bottom: 30px;
		}
		.stat-card {
			background: white;
			padding: 25px;
			border-radius: 10px;
			box-shadow: 0 2px 4px rgba(0,0,0,0.1);
		}
		.stat-label {
			font-size: 12px;
			text-transform: uppercase;
			color: #666;
			margin-bottom: 8px;
			font-weight: 600;
		}
		.stat-value {
			font-size: 36px;
			font-weight: bold;
			color: #f68a1e;
		}
		.section {
			background: white;
			padding: 25px;
			border-radius: 10px;
			margin-bottom: 20px;
			box-shadow: 0 2px 4px rgba(0,0,0,0.1);
		}
		.section-title {
			font-size: 18px;
			font-weight: 600;
			margin-bottom: 15px;
			color: #333;
		}
		.chart-bar {
			display: flex;
			align-items: center;
			margin-bottom: 12px;
		}
		.chart-label {
			min-width: 120px;
			font-size: 14px;
			color: #666;
		}
		.chart-bar-bg {
			flex: 1;
			height: 24px;
			background: #f0f0f0;
			border-radius: 4px;
			overflow: hidden;
			position: relative;
		}
		.chart-bar-fill {
			height: 100%;
			background: #f68a1e;
			transition: width 0.5s ease;
		}
		.chart-value {
			margin-left: 10px;
			font-weight: 600;
			min-width: 40px;
			text-align: right;
		}
		.feedback-item {
			padding: 15px;
			border-left: 4px solid #f68a1e;
			background: #fafafa;
			margin-bottom: 10px;
			border-radius: 4px;
		}
		.feedback-meta {
			font-size: 12px;
			color: #666;
			margin-bottom: 8px;
		}
		.feedback-text {
			font-size: 14px;
			line-height: 1.5;
		}
		.badge {
			display: inline-block;
			padding: 3px 8px;
			border-radius: 3px;
			font-size: 11px;
			font-weight: 600;
			margin-right: 5px;
		}
		.badge-high { background: #fee; color: #c33; }
		.badge-medium { background: #ffeaa7; color: #d63031; }
		.badge-low { background: #e8f5e9; color: #2e7d32; }
		.badge-positive { background: #e8f5e9; color: #2e7d32; }
		.badge-negative { background: #fee; color: #c33; }
		.badge-neutral { background: #f0f0f0; color: #666; }
		.loading {
			text-align: center;
			padding: 40px;
			color: #999;
		}
		.button {
			background: #f68a1e;
			color: white;
			border: none;
			padding: 12px 24px;
			border-radius: 6px;
			font-size: 14px;
			font-weight: 600;
			cursor: pointer;
			transition: background 0.2s;
		}
		.button:hover { background: #d67816; }
		.button:disabled {
			background: #ccc;
			cursor: not-allowed;
		}
		.button-secondary {
			background: white;
			color: #f68a1e;
			border: 2px solid #f68a1e;
		}
		.button-secondary:hover {
			background: #fff5ee;
		}
		.actions {
			display: flex;
			gap: 10px;
			margin-bottom: 20px;
			flex-wrap: wrap;
		}
		.insight-card {
			background: #fff5ee;
			border-left: 4px solid #f68a1e;
			padding: 20px;
			margin-bottom: 15px;
			border-radius: 4px;
		}
		.insight-title {
			font-weight: 600;
			font-size: 16px;
			margin-bottom: 10px;
			color: #333;
		}
		.insight-list {
			list-style: none;
			padding: 0;
		}
		.insight-list li {
			padding: 8px 0;
			border-bottom: 1px solid #ffe4cc;
			font-size: 14px;
			line-height: 1.6;
		}
		.insight-list li:last-child {
			border-bottom: none;
		}
		.priority-high {
			background: #fee;
			border-left-color: #c33;
		}
		.priority-medium {
			background: #ffeaa7;
			border-left-color: #d63031;
		}
		.priority-low {
			background: #e8f5e9;
			border-left-color: #2e7d32;
		}
		.tabs {
			display: flex;
			gap: 10px;
			margin-bottom: 20px;
			border-bottom: 2px solid #f0f0f0;
		}
		.tab {
			padding: 12px 24px;
			background: none;
			border: none;
			border-bottom: 3px solid transparent;
			cursor: pointer;
			font-size: 14px;
			font-weight: 600;
			color: #666;
			transition: all 0.2s;
		}
		.tab:hover {
			color: #f68a1e;
		}
		.tab.active {
			color: #f68a1e;
			border-bottom-color: #f68a1e;
		}
		.tab-content {
			display: none;
		}
		.tab-content.active {
			display: block;
		}
		.metric-change {
			font-size: 12px;
			margin-top: 5px;
		}
		.metric-change.positive {
			color: #2e7d32;
		}
		.metric-change.negative {
			color: #c33;
		}
		.empty-state {
			text-align: center;
			padding: 60px 20px;
			color: #999;
		}
		.empty-state-icon {
			font-size: 48px;
			margin-bottom: 20px;
		}
		.theme-tag {
			display: inline-block;
			padding: 4px 12px;
			background: #f0f0f0;
			border-radius: 12px;
			font-size: 12px;
			margin: 4px;
			font-weight: 500;
		}
		.theme-tag.negative {
			background: #fee;
			color: #c33;
		}
		.filters {
			display: flex;
			gap: 10px;
			margin-bottom: 20px;
			flex-wrap: wrap;
		}
		.filter-chip {
			padding: 8px 16px;
			background: white;
			border: 2px solid #e0e0e0;
			border-radius: 20px;
			cursor: pointer;
			font-size: 13px;
			transition: all 0.2s;
		}
		.filter-chip:hover {
			border-color: #f68a1e;
		}
		.filter-chip.active {
			background: #f68a1e;
			color: white;
			border-color: #f68a1e;
		}
		.progress-bar {
			width: 100%;
			height: 6px;
			background: #f0f0f0;
			border-radius: 3px;
			overflow: hidden;
			margin: 10px 0;
		}
		.progress-fill {
			height: 100%;
			background: #f68a1e;
			transition: width 0.3s ease;
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>📊 PM Feedback Dashboard</h1>
			<p class="subtitle">Actionable customer insights powered by AI - Make data-driven product decisions</p>
		</header>

		<div class="actions">
			<button class="button" onclick="analyzeAll()" id="analyze-btn">🤖 Analyze All Feedback</button>
			<button class="button-secondary button" onclick="refreshData()">🔄 Refresh</button>
			<button class="button-secondary button" onclick="exportData()">📥 Export CSV</button>
		</div>

		<div id="analysis-progress" style="display:none;">
			<div style="font-size: 14px; margin-bottom: 8px; color: #666;">
				<span id="progress-text">Analyzing feedback...</span>
			</div>
			<div class="progress-bar">
				<div class="progress-fill" id="progress-fill" style="width: 0%"></div>
			</div>
		</div>

		<div class="tabs">
			<button class="tab active" onclick="switchTab('overview')">📈 Overview</button>
			<button class="tab" onclick="switchTab('insights')">💡 Insights & Actions</button>
			<button class="tab" onclick="switchTab('details')">📋 All Feedback</button>
		</div>

		<!-- Overview Tab -->
		<div id="overview-tab" class="tab-content active">
			<div class="stats-grid">
				<div class="stat-card">
					<div class="stat-label">Total Feedback</div>
					<div class="stat-value" id="total-count">-</div>
				</div>
				<div class="stat-card">
					<div class="stat-label">Sentiment Score</div>
					<div class="stat-value" id="sentiment-score">-</div>
					<div class="metric-change" id="sentiment-change">-</div>
				</div>
				<div class="stat-card">
					<div class="stat-label">Feature Requests</div>
					<div class="stat-value" id="feature-count">-</div>
				</div>
				<div class="stat-card">
					<div class="stat-label">Critical Issues</div>
					<div class="stat-value" id="urgent-count">-</div>
				</div>
			</div>

			<div class="section">
				<h2 class="section-title">Feedback by Source</h2>
				<div id="source-chart"></div>
			</div>

			<div class="section">
				<h2 class="section-title">Sentiment Distribution</h2>
				<div id="sentiment-chart"></div>
			</div>
		</div>

		<!-- Insights Tab -->
		<div id="insights-tab" class="tab-content">
			<div class="section">
				<h2 class="section-title">⚡ Action Items for PM</h2>
				<div id="action-items"></div>
			</div>

			<div class="section">
				<h2 class="section-title">🚨 Top Priority Issues</h2>
				<p style="color: #666; font-size: 14px; margin-bottom: 15px;">High-urgency negative feedback requiring immediate attention</p>
				<div id="priority-issues"></div>
			</div>

			<div class="section">
				<h2 class="section-title">💡 Most Requested Features</h2>
				<div id="feature-requests"></div>
			</div>

			<div class="section">
				<h2 class="section-title">🎯 Theme Analysis</h2>
				<p style="color: #666; font-size: 14px; margin-bottom: 15px;">Customer feedback categorized by theme</p>
				<div id="theme-breakdown"></div>
			</div>

			<div class="section">
				<h2 class="section-title">😊 Quick Wins</h2>
				<p style="color: #666; font-size: 14px; margin-bottom: 15px;">Things customers love - amplify these!</p>
				<div id="quick-wins"></div>
			</div>
		</div>

		<!-- Details Tab -->
		<div id="details-tab" class="tab-content">
			<div class="section">
				<div class="filters">
					<div class="filter-chip active" onclick="filterFeedback('all')">All</div>
					<div class="filter-chip" onclick="filterFeedback('bug')">🐛 Bugs</div>
					<div class="filter-chip" onclick="filterFeedback('feature-request')">💡 Features</div>
					<div class="filter-chip" onclick="filterFeedback('high')">🚨 High Urgency</div>
					<div class="filter-chip" onclick="filterFeedback('negative')">👎 Negative</div>
					<div class="filter-chip" onclick="filterFeedback('positive')">👍 Positive</div>
				</div>
				<div id="all-feedback"></div>
			</div>
		</div>
	</div>

	<script>
		let allFeedbackData = [];
		let currentFilter = 'all';

		async function loadStats() {
			try {
				const response = await fetch('/api/stats');
				const data = await response.json();

				// Update stat cards
				document.getElementById('total-count').textContent = data.total;

				// Calculate sentiment score
				const total = (data.by_sentiment.positive || 0) + (data.by_sentiment.negative || 0) + (data.by_sentiment.neutral || 0);
				let score = '-';
				let sentiment = 'neutral';
				if (total > 0) {
					const positiveRatio = ((data.by_sentiment.positive || 0) / total * 100).toFixed(0);
					score = positiveRatio + '%';
					sentiment = positiveRatio >= 60 ? 'positive' : positiveRatio >= 40 ? 'neutral' : 'negative';
				}
				document.getElementById('sentiment-score').textContent = score;
				const changeEl = document.getElementById('sentiment-change');
				changeEl.textContent = sentiment === 'positive' ? '↗ Trending positive' : sentiment === 'negative' ? '↘ Needs attention' : '→ Stable';
				changeEl.className = 'metric-change ' + sentiment;

				// Count features and critical issues
				const featureCount = await countByTheme('feature-request');
				document.getElementById('feature-count').textContent = featureCount;
				document.getElementById('urgent-count').textContent = data.by_urgency.high || 0;

				// Render charts
				renderChart('source-chart', data.by_source);
				renderChart('sentiment-chart', data.by_sentiment);

			} catch (error) {
				console.error('Error loading stats:', error);
			}
		}

		async function countByTheme(theme) {
			try {
				const response = await fetch('/api/feedback');
				const feedback = await response.json();
				return feedback.filter(f => f.themes && f.themes.includes(theme)).length;
			} catch {
				return 0;
			}
		}

		async function loadInsights() {
			try {
				const response = await fetch('/api/insights');
				const data = await response.json();

				if (data.message) {
					document.getElementById('action-items').innerHTML = \`
						<div class="empty-state">
							<div class="empty-state-icon">🤖</div>
							<p>\${data.message}</p>
						</div>\`;
					return;
				}

				// Action Items
				const actionHTML = data.actionItems.map(item => \`<li>\${item}</li>\`).join('');
				document.getElementById('action-items').innerHTML = \`<ul class="insight-list">\${actionHTML}</ul>\`;

				// Priority Issues
				if (data.topPriorityIssues.length === 0) {
					document.getElementById('priority-issues').innerHTML = '<p style="color: #2e7d32;">✅ No critical issues detected</p>';
				} else {
					const priorityHTML = data.topPriorityIssues.map(issue => {
						const themeTag = issue.themes ? '<span class="theme-tag negative">' + issue.themes.split(',')[0] + '</span>' : '';
						return \`
							<div class="feedback-item">
								<div class="feedback-meta">
									<span class="badge badge-high">high</span>
									<strong>\${issue.source}</strong>
									\${themeTag}
								</div>
								<div class="feedback-text">\${issue.text}</div>
							</div>
						\`;
					}).join('');
					document.getElementById('priority-issues').innerHTML = priorityHTML;
				}

				// Feature Requests
				if (data.topFeatureRequests.length === 0) {
					document.getElementById('feature-requests').innerHTML = '<p style="color: #999;">No feature requests yet</p>';
				} else {
					const featureHTML = data.topFeatureRequests.map(f => \`
						<div class="feedback-item">
							<div class="feedback-meta">
								<span class="badge badge-\${f.sentiment}">\${f.sentiment}</span>
								<strong>\${f.source}</strong>
							</div>
							<div class="feedback-text">\${f.text}</div>
						</div>
					\`).join('');
					document.getElementById('feature-requests').innerHTML = featureHTML;
				}

				// Theme Breakdown
				const themeHTML = data.themeBreakdown.map(t => \`
					<div class="chart-bar">
						<div class="chart-label">\${t.theme}</div>
						<div class="chart-bar-bg">
							<div class="chart-bar-fill" style="width: \${t.count * 10}%; background: \${t.sentiment === 'negative' ? '#c33' : '#2e7d32'}"></div>
						</div>
						<div class="chart-value">\${t.count}</div>
					</div>
				\`).join('');
				document.getElementById('theme-breakdown').innerHTML = themeHTML;

				// Quick Wins
				if (data.quickWins.length > 0) {
					const winsHTML = data.quickWins.map(w => {
						const themeTag = w.themes ? '<span class="theme-tag">' + w.themes.split(',')[0] + '</span>' : '';
						return \`
							<div class="feedback-item" style="border-left-color: #2e7d32;">
								<div class="feedback-meta">
									<strong>\${w.source}</strong>
									\${themeTag}
								</div>
								<div class="feedback-text">\${w.text}</div>
							</div>
						\`;
					}).join('');
					document.getElementById('quick-wins').innerHTML = winsHTML;
				}

			} catch (error) {
				console.error('Error loading insights:', error);
			}
		}

		async function loadAllFeedback() {
			try {
				const response = await fetch('/api/feedback');
				allFeedbackData = await response.json();
				renderFilteredFeedback();
			} catch (error) {
				console.error('Error loading feedback:', error);
			}
		}

		function renderFilteredFeedback() {
			const container = document.getElementById('all-feedback');
			let filtered = allFeedbackData;

			if (currentFilter !== 'all') {
				if (currentFilter === 'bug' || currentFilter === 'feature-request') {
					filtered = allFeedbackData.filter(f => f.themes && f.themes.includes(currentFilter));
				} else if (currentFilter === 'high') {
					filtered = allFeedbackData.filter(f => f.urgency === 'high');
				} else if (currentFilter === 'negative' || currentFilter === 'positive') {
					filtered = allFeedbackData.filter(f => f.sentiment === currentFilter);
				}
			}

			if (filtered.length === 0) {
				container.innerHTML = '<div class="empty-state"><p>No feedback matches this filter</p></div>';
				return;
			}

			const html = filtered.map(item => {
				const urgencyBadge = item.urgency ? '<span class="badge badge-' + item.urgency + '">' + item.urgency + '</span>' : '';
				const sentimentBadge = item.sentiment ? '<span class="badge badge-' + item.sentiment + '">' + item.sentiment + '</span>' : '';
				const themeTags = item.themes ? item.themes.split(',').map(t => '<span class="theme-tag">' + t.trim() + '</span>').join('') : '';
				return \`
					<div class="feedback-item">
						<div class="feedback-meta">
							\${urgencyBadge}
							\${sentimentBadge}
							<strong>\${item.source}</strong> • \${new Date(item.created_at).toLocaleDateString()}
							\${themeTags}
						</div>
						<div class="feedback-text">\${item.text}</div>
					</div>
				\`;
			}).join('');
			container.innerHTML = html;
		}

		function filterFeedback(filter) {
			currentFilter = filter;
			document.querySelectorAll('.filter-chip').forEach(chip => {
				chip.classList.remove('active');
			});
			event.target.classList.add('active');
			renderFilteredFeedback();
		}

		function renderChart(elementId, data) {
			const container = document.getElementById(elementId);
			container.innerHTML = '';

			const max = Math.max(...Object.values(data));

			for (const [key, value] of Object.entries(data)) {
				const width = max > 0 ? (value / max * 100) : 0;

				const bar = document.createElement('div');
				bar.className = 'chart-bar';
				bar.innerHTML = \`
					<div class="chart-label">\${key}</div>
					<div class="chart-bar-bg">
						<div class="chart-bar-fill" style="width: \${width}%"></div>
					</div>
					<div class="chart-value">\${value}</div>
				\`;
				container.appendChild(bar);
			}
		}

		async function analyzeAll() {
			const button = document.getElementById('analyze-btn');
			const progress = document.getElementById('analysis-progress');
			const progressFill = document.getElementById('progress-fill');
			const progressText = document.getElementById('progress-text');

			button.disabled = true;
			button.textContent = '⏳ Analyzing...';
			progress.style.display = 'block';

			// Simulate progress for better UX
			let progressValue = 0;
			const progressInterval = setInterval(() => {
				progressValue += 5;
				if (progressValue <= 90) {
					progressFill.style.width = progressValue + '%';
					progressText.textContent = \`Analyzing feedback with AI... \${progressValue}%\`;
				}
			}, 200);

			try {
				const response = await fetch('/api/analyze-all', { method: 'POST' });
				const result = await response.json();

				clearInterval(progressInterval);
				progressFill.style.width = '100%';
				progressText.textContent = \`✅ Analyzed \${result.analyzed} feedback entries!\`;

				setTimeout(async () => {
					progress.style.display = 'none';
					progressFill.style.width = '0%';
					await loadStats();
					await loadInsights();
					await loadAllFeedback();
				}, 1500);

			} catch (error) {
				clearInterval(progressInterval);
				alert('Error analyzing feedback: ' + error.message);
				progress.style.display = 'none';
			} finally {
				button.disabled = false;
				button.textContent = '🤖 Analyze All Feedback';
			}
		}

		async function refreshData() {
			await loadStats();
			await loadInsights();
			await loadAllFeedback();
		}

		function switchTab(tabName) {
			// Update tab buttons
			document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
			event.target.classList.add('active');

			// Update tab content
			document.querySelectorAll('.tab-content').forEach(content => {
				content.classList.remove('active');
			});
			document.getElementById(tabName + '-tab').classList.add('active');

			// Load data if needed
			if (tabName === 'insights') {
				loadInsights();
			} else if (tabName === 'details') {
				loadAllFeedback();
			}
		}

		function exportData() {
			// Simple CSV export
			if (allFeedbackData.length === 0) {
				alert('No data to export. Load the "All Feedback" tab first.');
				return;
			}

			const csv = [
				['ID', 'Source', 'Text', 'Sentiment', 'Themes', 'Urgency', 'Date'],
				...allFeedbackData.map(f => [
					f.id,
					f.source,
					\`"\${f.text.replace(/"/g, '""')}"\`,
					f.sentiment || '',
					f.themes || '',
					f.urgency || '',
					f.created_at
				])
			].map(row => row.join(',')).join('\\n');

			const blob = new Blob([csv], { type: 'text/csv' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = \`feedback-export-\${new Date().toISOString().split('T')[0]}.csv\`;
			a.click();
		}

		// Load data on page load
		loadStats();
		loadInsights();
		loadAllFeedback();

		// Auto-refresh every 60 seconds (increased from 30 to reduce load)
		setInterval(() => {
			loadStats();
		}, 60000);
	</script>
</body>
</html>`;
}

