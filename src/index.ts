/**
 * Feedback Analyzer Worker
 * 
 * A Cloudflare Worker that collects, analyzes, and provides insights on user feedback
 * from multiple sources using D1 Database, Workers AI, and KV for caching.
 */

export interface Env {
	DB: D1Database;
	AI: Ai;
	CACHE: KVNamespace;
}

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
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS headers for all responses
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle preflight requests
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			// Dashboard
			if (path === '/' && request.method === 'GET') {
				return new Response(getDashboardHTML(), {
					headers: {
						'Content-Type': 'text/html',
						...corsHeaders,
					},
				});
			}

			// API Routes
			if (path === '/api/feedback' && request.method === 'GET') {
				return listFeedback(env, corsHeaders);
			}

			if (path === '/api/feedback' && request.method === 'POST') {
				return submitFeedback(request, env, ctx, corsHeaders);
			}

			if (path === '/api/stats' && request.method === 'GET') {
				return getStats(env, ctx, corsHeaders);
			}

			if (path.startsWith('/api/analyze/') && request.method === 'POST') {
				const id = parseInt(path.split('/').pop() || '');
				return analyzeFeedback(id, env, ctx, corsHeaders);
			}

			if (path === '/api/analyze-all' && request.method === 'POST') {
				return analyzeAllFeedback(env, ctx, corsHeaders);
			}

			if (path === '/api/insights' && request.method === 'GET') {
				return getInsights(env, corsHeaders);
			}

			return new Response('Not Found', { 
				status: 404,
				headers: corsHeaders,
			});
		} catch (error) {
			console.error('Error handling request:', error);
			return new Response(JSON.stringify({ 
				error: 'Internal Server Error',
				message: error instanceof Error ? error.message : 'Unknown error',
			}), {
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		}
	},
};

/**
 * List all feedback entries
 */
async function listFeedback(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const result = await env.DB.prepare(
		'SELECT * FROM feedback ORDER BY created_at DESC'
	).all();

	return new Response(JSON.stringify(result.results), {
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		},
	});
}

/**
 * Submit new feedback
 */
async function submitFeedback(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	corsHeaders: Record<string, string>
): Promise<Response> {
	const body = await request.json() as FeedbackEntry;

	// Validate required fields
	if (!body.source || !body.text) {
		return new Response(JSON.stringify({ error: 'Missing required fields: source and text' }), {
			status: 400,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders,
			},
		});
	}

	// Insert feedback
	const result = await env.DB.prepare(
		`INSERT INTO feedback (source, text, sentiment, themes, urgency, created_at)
		 VALUES (?, ?, ?, ?, ?, datetime('now'))
		 RETURNING *`
	).bind(
		body.source,
		body.text,
		body.sentiment || null,
		body.themes || null,
		body.urgency || null
	).first();

	// Invalidate stats cache
	ctx.waitUntil(env.CACHE.delete('stats'));

	return new Response(JSON.stringify(result), {
		status: 201,
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		},
	});
}

/**
 * Get aggregated statistics with caching
 */
async function getStats(
	env: Env,
	ctx: ExecutionContext,
	corsHeaders: Record<string, string>
): Promise<Response> {
	// Try to get from cache first
	const cached = await env.CACHE.get('stats', 'json');
	if (cached) {
		return new Response(JSON.stringify(cached), {
			headers: {
				'Content-Type': 'application/json',
				'X-Cache': 'HIT',
				...corsHeaders,
			},
		});
	}

	// Calculate stats
	const [total, bySource, bySentiment, byUrgency, recentUrgent] = await Promise.all([
		env.DB.prepare('SELECT COUNT(*) as count FROM feedback').first<{ count: number }>(),
		env.DB.prepare(`
			SELECT source, COUNT(*) as count 
			FROM feedback 
			GROUP BY source
		`).all(),
		env.DB.prepare(`
			SELECT sentiment, COUNT(*) as count 
			FROM feedback 
			WHERE sentiment IS NOT NULL
			GROUP BY sentiment
		`).all(),
		env.DB.prepare(`
			SELECT urgency, COUNT(*) as count 
			FROM feedback 
			WHERE urgency IS NOT NULL
			GROUP BY urgency
		`).all(),
		env.DB.prepare(`
			SELECT * FROM feedback 
			WHERE urgency = 'urgent' 
			ORDER BY created_at DESC 
			LIMIT 10
		`).all(),
	]);

	const stats: AggregatedStats = {
		total: total?.count || 0,
		by_source: {},
		by_sentiment: {},
		by_urgency: {},
		recent_urgent: recentUrgent.results as FeedbackEntry[],
		timestamp: new Date().toISOString(),
	};

	// Aggregate by source
	for (const row of bySource.results as Array<{ source: string; count: number }>) {
		stats.by_source[row.source] = row.count;
	}

	// Aggregate by sentiment
	for (const row of bySentiment.results as Array<{ sentiment: string; count: number }>) {
		stats.by_sentiment[row.sentiment] = row.count;
	}

	// Aggregate by urgency
	for (const row of byUrgency.results as Array<{ urgency: string; count: number }>) {
		stats.by_urgency[row.urgency] = row.count;
	}

	// Cache for 5 minutes
	ctx.waitUntil(
		env.CACHE.put('stats', JSON.stringify(stats), {
			expirationTtl: 300,
		})
	);

	return new Response(JSON.stringify(stats), {
		headers: {
			'Content-Type': 'application/json',
			'X-Cache': 'MISS',
			'Cache-Control': 'public, max-age=60',
			...corsHeaders,
		},
	});
}

/**
 * Analyze a single feedback entry
 */
async function analyzeFeedback(
	id: number,
	env: Env,
	ctx: ExecutionContext,
	corsHeaders: Record<string, string>
): Promise<Response> {
	if (isNaN(id)) {
		return new Response(JSON.stringify({ error: 'Invalid feedback ID' }), {
			status: 400,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders,
			},
		});
	}

	// Get feedback entry
	const feedback = await env.DB.prepare(
		'SELECT * FROM feedback WHERE id = ?'
	).bind(id).first<FeedbackEntry>();

	if (!feedback) {
		return new Response(JSON.stringify({ error: 'Feedback not found' }), {
			status: 404,
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders,
			},
		});
	}

	// Analyze with AI
	const analysis = await analyzeWithAI(feedback.text, env);

	// Update feedback with analysis
	const updated = await env.DB.prepare(
		`UPDATE feedback 
		 SET sentiment = ?, themes = ?, urgency = ?
		 WHERE id = ?
		 RETURNING *`
	).bind(
		analysis.sentiment,
		analysis.themes,
		analysis.urgency,
		id
	).first();

	// Invalidate stats cache
	ctx.waitUntil(env.CACHE.delete('stats'));

	return new Response(JSON.stringify(updated), {
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		},
	});
}

/**
 * Analyze all unanalyzed feedback
 */
async function analyzeAllFeedback(
	env: Env,
	ctx: ExecutionContext,
	corsHeaders: Record<string, string>
): Promise<Response> {
	// Get all feedback without analysis
	const unanalyzed = await env.DB.prepare(
		'SELECT * FROM feedback WHERE sentiment IS NULL LIMIT 50'
	).all<FeedbackEntry>();

	if (unanalyzed.results.length === 0) {
		return new Response(JSON.stringify({ 
			message: 'No unanalyzed feedback found',
			analyzed: 0,
		}), {
			headers: {
				'Content-Type': 'application/json',
				...corsHeaders,
			},
		});
	}

	const results = [];
	const batchSize = 5;

	// Process in batches to avoid overwhelming the AI
	for (let i = 0; i < unanalyzed.results.length; i += batchSize) {
		const batch = unanalyzed.results.slice(i, i + batchSize);
		const batchPromises = batch.map(async (feedback) => {
			try {
				const analysis = await analyzeWithAI(feedback.text!, env);
				await env.DB.prepare(
					`UPDATE feedback 
					 SET sentiment = ?, themes = ?, urgency = ?
					 WHERE id = ?`
				).bind(
					analysis.sentiment,
					analysis.themes,
					analysis.urgency,
					feedback.id
				).run();
				return { id: feedback.id, success: true };
			} catch (error) {
				console.error(`Failed to analyze feedback ${feedback.id}:`, error);
				return { id: feedback.id, success: false, error: error instanceof Error ? error.message : 'Unknown error' };
			}
		});

		const batchResults = await Promise.all(batchPromises);
		results.push(...batchResults);
	}

	// Invalidate stats cache
	ctx.waitUntil(env.CACHE.delete('stats'));

	const successful = results.filter(r => r.success).length;
	const failed = results.filter(r => !r.success).length;

	return new Response(JSON.stringify({
		message: 'Analysis complete',
		total: results.length,
		successful,
		failed,
		results,
	}), {
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		},
	});
}

/**
 * Use Workers AI to analyze feedback
 */
async function analyzeWithAI(text: string, env: Env): Promise<{
	sentiment: string;
	themes: string;
	urgency: string;
}> {
	const prompt = `Analyze the following user feedback and provide:
1. Sentiment (positive, negative, or neutral)
2. Main themes (comma-separated keywords, max 5)
3. Urgency level (urgent, normal, or low)

Feedback: "${text}"

Respond in this exact format:
Sentiment: [sentiment]
Themes: [theme1, theme2, theme3]
Urgency: [urgency]`;

	const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
		prompt,
		max_tokens: 150,
	}) as { response: string };

	// Parse the response
	const lines = response.response.split('\n').filter(line => line.trim());
	let sentiment = 'neutral';
	let themes = '';
	let urgency = 'normal';

	for (const line of lines) {
		if (line.toLowerCase().startsWith('sentiment:')) {
			sentiment = line.split(':')[1].trim().toLowerCase();
		} else if (line.toLowerCase().startsWith('themes:')) {
			themes = line.split(':')[1].trim();
		} else if (line.toLowerCase().startsWith('urgency:')) {
			urgency = line.split(':')[1].trim().toLowerCase();
		}
	}

	// Validate and normalize values
	if (!['positive', 'negative', 'neutral'].includes(sentiment)) {
		sentiment = 'neutral';
	}
	if (!['urgent', 'normal', 'low'].includes(urgency)) {
		urgency = 'normal';
	}

	return { sentiment, themes, urgency };
}

/**
 * Get PM-focused insights
 */
async function getInsights(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
	const [priorityIssues, featureRequests, positiveHighlights, recentFeedback] = await Promise.all([
		// Priority issues (urgent + negative)
		env.DB.prepare(`
			SELECT * FROM feedback 
			WHERE urgency = 'urgent' AND sentiment = 'negative'
			ORDER BY created_at DESC
			LIMIT 5
		`).all(),

		// Feature requests (contains keywords)
		env.DB.prepare(`
			SELECT * FROM feedback 
			WHERE text LIKE '%feature%' 
			   OR text LIKE '%request%' 
			   OR text LIKE '%add%'
			   OR text LIKE '%support%'
			ORDER BY created_at DESC
			LIMIT 5
		`).all(),

		// Positive highlights
		env.DB.prepare(`
			SELECT * FROM feedback 
			WHERE sentiment = 'positive'
			ORDER BY created_at DESC
			LIMIT 5
		`).all(),

		// Recent feedback for trend analysis
		env.DB.prepare(`
			SELECT created_at, sentiment, themes 
			FROM feedback 
			WHERE created_at >= datetime('now', '-7 days')
			ORDER BY created_at DESC
		`).all(),
	]);

	// Calculate sentiment trend
	const sentimentTrend: Record<string, number> = {};
	for (const entry of recentFeedback.results as Array<{ sentiment: string | null }>) {
		if (entry.sentiment) {
			sentimentTrend[entry.sentiment] = (sentimentTrend[entry.sentiment] || 0) + 1;
		}
	}

	// Extract common themes
	const themeCounts: Record<string, number> = {};
	for (const entry of recentFeedback.results as Array<{ themes: string | null }>) {
		if (entry.themes) {
			const themes = entry.themes.split(',').map(t => t.trim().toLowerCase());
			for (const theme of themes) {
				if (theme) {
					themeCounts[theme] = (themeCounts[theme] || 0) + 1;
				}
			}
		}
	}

	const topThemes = Object.entries(themeCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([theme, count]) => ({ theme, count }));

	const insights = {
		action_items: priorityIssues.results,
		feature_requests: featureRequests.results,
		positive_highlights: positiveHighlights.results,
		sentiment_trend: sentimentTrend,
		top_themes: topThemes,
		generated_at: new Date().toISOString(),
	};

	return new Response(JSON.stringify(insights), {
		headers: {
			'Content-Type': 'application/json',
			...corsHeaders,
		},
	});
}

/**
 * Dashboard HTML with embedded CSS and JavaScript
 */
function getDashboardHTML(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Feedback Analyzer Dashboard</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
			padding: 20px;
			color: #333;
		}

		.container {
			max-width: 1400px;
			margin: 0 auto;
		}

		header {
			text-align: center;
			color: white;
			margin-bottom: 40px;
		}

		h1 {
			font-size: 2.5rem;
			margin-bottom: 10px;
			text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.2);
		}

		.subtitle {
			font-size: 1.1rem;
			opacity: 0.9;
		}

		.dashboard-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
			gap: 20px;
			margin-bottom: 30px;
		}

		.card {
			background: white;
			border-radius: 12px;
			padding: 24px;
			box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
			transition: transform 0.2s, box-shadow 0.2s;
		}

		.card:hover {
			transform: translateY(-2px);
			box-shadow: 0 8px 12px rgba(0, 0, 0, 0.15);
		}

		.card h2 {
			font-size: 1.5rem;
			margin-bottom: 16px;
			color: #667eea;
		}

		.stat-number {
			font-size: 3rem;
			font-weight: bold;
			color: #667eea;
			margin: 10px 0;
		}

		.stat-list {
			list-style: none;
		}

		.stat-list li {
			padding: 8px 0;
			border-bottom: 1px solid #eee;
			display: flex;
			justify-content: space-between;
			align-items: center;
		}

		.stat-list li:last-child {
			border-bottom: none;
		}

		.badge {
			display: inline-block;
			padding: 4px 12px;
			border-radius: 20px;
			font-size: 0.85rem;
			font-weight: 600;
		}

		.badge-positive {
			background: #d4edda;
			color: #155724;
		}

		.badge-negative {
			background: #f8d7da;
			color: #721c24;
		}

		.badge-neutral {
			background: #e2e3e5;
			color: #383d41;
		}

		.badge-urgent {
			background: #ff6b6b;
			color: white;
		}

		.badge-normal {
			background: #ffd93d;
			color: #333;
		}

		.badge-low {
			background: #6bcf7f;
			color: white;
		}

		.actions {
			display: flex;
			gap: 10px;
			margin-bottom: 30px;
			flex-wrap: wrap;
		}

		.btn {
			background: white;
			color: #667eea;
			border: 2px solid white;
			padding: 12px 24px;
			border-radius: 8px;
			font-size: 1rem;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s;
		}

		.btn:hover {
			background: #667eea;
			color: white;
			transform: translateY(-1px);
			box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
		}

		.btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.feedback-list {
			background: white;
			border-radius: 12px;
			padding: 24px;
			box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
		}

		.feedback-item {
			padding: 16px;
			border-left: 4px solid #667eea;
			background: #f8f9fa;
			margin-bottom: 16px;
			border-radius: 4px;
		}

		.feedback-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 8px;
			flex-wrap: wrap;
			gap: 8px;
		}

		.feedback-source {
			font-weight: 600;
			color: #667eea;
		}

		.feedback-date {
			font-size: 0.85rem;
			color: #6c757d;
		}

		.feedback-text {
			color: #495057;
			line-height: 1.6;
			margin-bottom: 8px;
		}

		.feedback-meta {
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
		}

		.loading {
			text-align: center;
			padding: 40px;
			color: white;
			font-size: 1.2rem;
		}

		.error {
			background: #f8d7da;
			color: #721c24;
			padding: 12px;
			border-radius: 8px;
			margin-bottom: 20px;
		}

		@media (max-width: 768px) {
			h1 {
				font-size: 2rem;
			}

			.dashboard-grid {
				grid-template-columns: 1fr;
			}

			.actions {
				flex-direction: column;
			}

			.btn {
				width: 100%;
			}
		}
	</style>
</head>
<body>
	<div class="container">
		<header>
			<h1>📊 Feedback Analyzer</h1>
			<p class="subtitle">Real-time insights from user feedback across all channels</p>
		</header>

		<div class="actions">
			<button class="btn" onclick="loadDashboard()">🔄 Refresh Data</button>
			<button class="btn" id="analyzeBtn" onclick="analyzeAll()">🤖 Analyze All</button>
			<button class="btn" onclick="viewInsights()">💡 View Insights</button>
		</div>

		<div id="error" class="error" style="display: none;"></div>
		<div id="loading" class="loading">Loading dashboard...</div>

		<div id="stats" class="dashboard-grid" style="display: none;"></div>
		<div id="feedback" class="feedback-list" style="display: none;">
			<h2>Recent Feedback</h2>
			<div id="feedbackList"></div>
		</div>
	</div>

	<script>
		async function loadDashboard() {
			try {
				document.getElementById('loading').style.display = 'block';
				document.getElementById('error').style.display = 'none';

				const [stats, feedback] = await Promise.all([
					fetch('/api/stats').then(r => r.json()),
					fetch('/api/feedback').then(r => r.json())
				]);

				renderStats(stats);
				renderFeedback(feedback);

				document.getElementById('loading').style.display = 'none';
				document.getElementById('stats').style.display = 'grid';
				document.getElementById('feedback').style.display = 'block';
			} catch (error) {
				showError('Failed to load dashboard: ' + error.message);
			}
		}

		function renderStats(stats) {
			const statsHtml = \`
				<div class="card">
					<h2>Total Feedback</h2>
					<div class="stat-number">\${stats.total}</div>
					<p>Across all channels</p>
				</div>

				<div class="card">
					<h2>By Source</h2>
					<ul class="stat-list">
						\${Object.entries(stats.by_source).map(([source, count]) => 
							\`<li><span>\${source}</span><span>\${count}</span></li>\`
						).join('')}
					</ul>
				</div>

				<div class="card">
					<h2>Sentiment Analysis</h2>
					<ul class="stat-list">
						\${Object.entries(stats.by_sentiment).map(([sentiment, count]) => 
							\`<li>
								<span class="badge badge-\${sentiment}">\${sentiment}</span>
								<span>\${count}</span>
							</li>\`
						).join('')}
					</ul>
				</div>

				<div class="card">
					<h2>Urgency Levels</h2>
					<ul class="stat-list">
						\${Object.entries(stats.by_urgency).map(([urgency, count]) => 
							\`<li>
								<span class="badge badge-\${urgency}">\${urgency}</span>
								<span>\${count}</span>
							</li>\`
						).join('')}
					</ul>
				</div>
			\`;

			document.getElementById('stats').innerHTML = statsHtml;
		}

		function renderFeedback(feedback) {
			const feedbackHtml = feedback.map(item => \`
				<div class="feedback-item">
					<div class="feedback-header">
						<span class="feedback-source">\${item.source}</span>
						<span class="feedback-date">\${new Date(item.created_at).toLocaleDateString()}</span>
					</div>
					<div class="feedback-text">\${item.text}</div>
					<div class="feedback-meta">
						\${item.sentiment ? \`<span class="badge badge-\${item.sentiment}">\${item.sentiment}</span>\` : ''}
						\${item.urgency ? \`<span class="badge badge-\${item.urgency}">\${item.urgency}</span>\` : ''}
						\${item.themes ? \`<span class="badge">\${item.themes}</span>\` : ''}
					</div>
				</div>
			\`).join('');

			document.getElementById('feedbackList').innerHTML = feedbackHtml;
		}

		async function analyzeAll() {
			const btn = document.getElementById('analyzeBtn');
			btn.disabled = true;
			btn.textContent = '⏳ Analyzing...';

			try {
				const response = await fetch('/api/analyze-all', { method: 'POST' });
				const result = await response.json();
				
				alert(\`Analysis complete!\\n\\nTotal: \${result.total}\\nSuccessful: \${result.successful}\\nFailed: \${result.failed}\`);
				
				// Reload dashboard
				await loadDashboard();
			} catch (error) {
				showError('Failed to analyze feedback: ' + error.message);
			} finally {
				btn.disabled = false;
				btn.textContent = '🤖 Analyze All';
			}
		}

		async function viewInsights() {
			try {
				const insights = await fetch('/api/insights').then(r => r.json());
				
				let message = '📊 PM Insights\\n\\n';
				message += \`🚨 Priority Issues: \${insights.action_items.length}\\n\`;
				message += \`💡 Feature Requests: \${insights.feature_requests.length}\\n\`;
				message += \`⭐ Positive Highlights: \${insights.positive_highlights.length}\\n\\n\`;
				message += '📈 Top Themes:\\n';
				insights.top_themes.slice(0, 5).forEach(theme => {
					message += \`  • \${theme.theme}: \${theme.count}\\n\`;
				});

				alert(message);
			} catch (error) {
				showError('Failed to load insights: ' + error.message);
			}
		}

		function showError(message) {
			const errorEl = document.getElementById('error');
			errorEl.textContent = message;
			errorEl.style.display = 'block';
			document.getElementById('loading').style.display = 'none';
		}

		// Load dashboard on page load
		loadDashboard();
	</script>
</body>
</html>`;
}
