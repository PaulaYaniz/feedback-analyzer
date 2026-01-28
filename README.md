# Feedback Analyzer

> **Cloudflare PM Intern Assignment - Summer 2026 (Lisbon, PT)**
>
> An AI-powered feedback aggregation and analysis tool built on Cloudflare's Developer Platform

![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)
![D1](https://img.shields.io/badge/Database-D1-F38020)
![Workers AI](https://img.shields.io/badge/AI-Workers%20AI-F38020)

---

## 🎯 Project Overview

A feedback management system through Cloudflare's serverless platform. This tool is a prototype that aggregates customer feedback from multiple sources and uses AI to automatically analyze sentiment, extract themes, and prioritize by urgency. It is designed to help product teams move from unstructured feedback to actionable prioritization without manual tagging or spreadsheet-based workflows.

### Key Features

- **AI-Powered Analysis** - Automatic sentiment detection, theme extraction, and urgency classification using Workers AI
- **Real-Time Analytics** - Live dashboard with aggregated statistics and visualizations
- **High Performance** - KV caching for low-latency response times on analytics queries
- **Global Scale** - Deployed on Cloudflare's edge network for low-latency worldwide
- **Clean UI** - Professional dashboard with no external dependencies

---

## 🏗️ Architecture

### Cloudflare Products Used

| Product | Purpose | Why This Choice |
|---------|---------|-----------------|
| **Workers** | Application runtime & API | Serverless, globally distributed, scales automatically. Perfect for API endpoints and serving HTML. |
| **D1 Database** | Feedback storage | SQL database at the edge. Familiar syntax, powerful queries, built-in replication. Ideal for structured feedback data. |
| **Workers AI** | Sentiment & theme analysis | On-platform LLM inference (Llama-3-8b), avoiding external APIs and reducing latency. |
| **KV** | Analytics caching | Ultra-fast key-value store. Cache expensive aggregate queries to reduce D1 load and improve response times. |

### Architecture Diagram

```
┌─────────────┐
│   Browser   │
│  Dashboard  │
└──────┬──────┘
       │ HTTPS
       ↓
┌──────────────────────────────────────┐
│      Cloudflare Worker               │
│  ┌────────────────────────────────┐  │
│  │  Request Router                │  │
│  │  - GET /                       │  │
│  │  - GET /api/feedback           │  │
│  │  - POST /api/feedback          │  │
│  │  - GET /api/stats              │  │
│  │  - POST /api/analyze/:id       │  │
│  │  - POST /api/analyze-all       │  │
│  └────┬───────┬──────────┬────────┘  │
│       │       │          │           │
│   ┌───↓───┐ ┌↓──────┐ ┌─↓────────┐  │
│   │  D1   │ │Workers│ │    KV    │  │
│   │  DB   │ │  AI   │ │  Cache   │  │
│   │       │ │       │ │          │  │
│   │Feedback│ │Llama-3│ │Analytics │  │
│   │Entries│ │Analyze│ │  Stats   │  │
│   └───────┘ └───────┘ └──────────┘  │
└──────────────────────────────────────┘
```

### Data Flow

1. **Feedback Submission** → Stored in D1 → Cache invalidated
2. **AI Analysis** → Workers AI analyzes text → Results stored in D1
3. **Analytics Request** → Check KV cache → If miss, query D1 → Cache result
4. **Dashboard** → Fetch `/api/stats` → Render visualizations

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm
- Cloudflare account ([sign up free](https://dash.cloudflare.com/sign-up))
- Wrangler CLI (installed automatically with project)

### 1. Clone and Install

```bash
git clone https://github.com/PaulaYaniz/feedback-analyzer.git
cd feedback-analyzer
npm install
```

### 2. Authenticate with Cloudflare

Choose one option:

**Option A: Interactive Login (Recommended for local development)**
```bash
npx wrangler login
```

**Option B: API Token (For CI/CD)**
```bash
export CLOUDFLARE_API_TOKEN="your-api-token"
```

Get an API token at: https://dash.cloudflare.com/profile/api-tokens

### 3. Create Cloudflare Resources

#### Create D1 Database
```bash
npx wrangler d1 create feedback-db
```

Copy the `database_id` from the output and update `wrangler.jsonc`:
```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "feedback-db",
    "database_id": "YOUR_DATABASE_ID_HERE"  // ← Update this
  }
]
```

#### Run Database Migrations
```bash
# Local database
npx wrangler d1 execute feedback-db --local --file=./schema.sql
npx wrangler d1 execute feedback-db --local --file=./seed.sql

# Remote database (for deployment)
npx wrangler d1 execute feedback-db --remote --file=./schema.sql
npx wrangler d1 execute feedback-db --remote --file=./seed.sql
```

#### Create KV Namespace
```bash
npx wrangler kv:namespace create CACHE
```

Copy the `id` from output and update `wrangler.jsonc`:
```jsonc
"kv_namespaces": [
  {
    "binding": "CACHE",
    "id": "YOUR_KV_ID_HERE"  // ← Update this
  }
]
```

**Note:** Workers AI binding is automatically available, no setup needed!

### 4. Local Development

```bash
npm run dev
```

Visit: http://localhost:8787

**Note:** Workers AI requires authentication and runs in remote mode. To test AI features locally:
```bash
npx wrangler dev --remote
```

### 5. Deploy to Cloudflare

```bash
npm run deploy
```

Your app will be live at: `https://feedback-analyzer.<your-subdomain>.workers.dev`

---

## 📡 API Documentation

### Endpoints

#### `GET /`
Serves the dashboard HTML

**Response:** HTML page

---

#### `GET /api/feedback`
List all feedback entries (most recent first, limit 100)

**Response:**
```json
[
  {
    "id": 1,
    "source": "GitHub",
    "text": "The API response time is extremely slow...",
    "sentiment": "negative",
    "themes": "performance, api",
    "urgency": "high",
    "created_at": "2026-01-20T10:30:00.000Z"
  }
]
```

---

#### `POST /api/feedback`
Submit new feedback

**Request Body:**
```json
{
  "source": "Discord",
  "text": "Love the new dashboard UI!"
}
```

**Response:**
```json
{
  "id": 31,
  "source": "Discord",
  "text": "Love the new dashboard UI!",
  "sentiment": null,
  "themes": null,
  "urgency": null,
  "created_at": "2026-01-24T16:45:23.000Z"
}
```

---

#### `GET /api/stats`
Get aggregated analytics (cached for 5 minutes)

**Response:**
```json
{
  "total": 30,
  "by_source": {
    "GitHub": 5,
    "Discord": 5,
    "Twitter": 5,
    "Support Ticket": 5,
    "Email": 5,
    "Forum": 5
  },
  "by_sentiment": {
    "positive": 8,
    "negative": 12,
    "neutral": 10
  },
  "by_urgency": {
    "low": 10,
    "medium": 15,
    "high": 5
  },
  "recent_urgent": [
    { "id": 15, "text": "...", "source": "Twitter", ... }
  ],
  "timestamp": "2026-01-24T16:50:00.000Z"
}
```

**Headers:**
- `X-Cache: HIT` - Served from cache
- `X-Cache: MISS` - Freshly calculated

---

## 🎓 Learning Outcomes

### Technical Skills Demonstrated

- Serverless architecture design
- RESTful API development
- SQL database schema design
- AI/ML integration for text analysis
- Caching strategies for performance
- Frontend development (vanilla JS)
- TypeScript for type safety

### Product Skills Demonstrated

- Problem definition and solution design
- Technology selection and justification
- User experience design (dashboard)
- Performance optimization
- Product friction identification
- Documentation and communication

---

## 🎯 Future Work

Add authentication and role-based access, introduce feedback source integrations via webhooks, and expand analytics with trend detection and alerting for emerging issues.

---

## 🙏 Acknowledgments

Built for the **Cloudflare PM Intern Assignment - Summer 2026**

**Tools Used:**
- [Claude Code](https://claude.com/claude-code) - AI-assisted development
- [Cloudflare Developer Platform](https://developers.cloudflare.com/)
- TypeScript, SQL, HTML/CSS/JS
