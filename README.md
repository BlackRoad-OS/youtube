# ⬛⬜🛣️ BlackRoad YouTube Workers

YouTube video publishing and media channels for the BlackRoad system, powered by Cloudflare Workers with Agent Automation and Self-Healing capabilities.

## Features

- **Agent-Based Architecture**: Distributed agents for task management, repo scraping, and sync
- **Cross-Repo Scraping**: Automatically scrapes and indexes all BlackRoad repos for cohesiveness
- **Self-Healing System**: Automatic issue detection and resolution with circuit breaker pattern
- **Auto-Updates**: Watches for changes across repos and triggers automatic syncs
- **Scheduled Jobs**: Cron-based health checks, syncs, and cleanup tasks
- **Durable Objects**: Persistent state management for all agents

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Edge                      │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Hono      │  │  Scheduled  │  │   Queue     │              │
│  │   Router    │  │   Handler   │  │  Consumer   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│  ┌──────▼────────────────▼────────────────▼──────┐              │
│  │              Agent Coordinator                 │              │
│  │         (Durable Object - Orchestration)       │              │
│  └─────┬─────────┬─────────┬─────────┬───────────┘              │
│        │         │         │         │                          │
│  ┌─────▼───┐ ┌───▼────┐ ┌──▼─────┐ ┌─▼──────────┐               │
│  │  Repo   │ │  Task  │ │  Self  │ │   Sync     │               │
│  │ Scraper │ │ Queue  │ │ Healer │ │  Manager   │               │
│  └────┬────┘ └───┬────┘ └───┬────┘ └─────┬──────┘               │
│       │          │          │            │                       │
├───────▼──────────▼──────────▼────────────▼───────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │   KV    │  │   D1    │  │   R2    │  │ Queues  │             │
│  │ Storage │  │   SQL   │  │ Buckets │  │         │             │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

## Agents

| Agent | Purpose |
|-------|---------|
| **AgentCoordinator** | Central orchestration, health monitoring, agent registry |
| **RepoScraperAgent** | Scrapes GitHub repos, analyzes interfaces, tracks structure |
| **TaskQueueAgent** | Task scheduling, prioritization, retry with backoff |
| **SelfHealerAgent** | Automatic issue detection, healing actions, circuit breaker |
| **SyncManagerAgent** | Cross-repo sync, webhook handling, update detection |

## API Endpoints

### Health & Status
- `GET /` - Worker info and available endpoints
- `GET /api/health` - System health check

### Agents
- `GET /api/agents` - List all agents
- `GET /api/agents/:name` - Get specific agent status
- `POST /api/agents/:name/trigger` - Trigger agent action

### Repositories
- `GET /api/repos` - List all tracked repos
- `GET /api/repos/:name` - Get repo details
- `POST /api/repos/:name/scrape` - Trigger repo scrape
- `GET /api/repos/:name/interfaces` - Get repo interfaces

### Tasks
- `GET /api/tasks` - List tasks
- `POST /api/tasks` - Create new task
- `GET /api/tasks/:id` - Get task details

### Sync
- `POST /api/sync/webhook` - GitHub webhook receiver
- `POST /api/sync/trigger` - Manual sync trigger

### Self-Healing
- `GET /api/heal/status` - Healer status
- `GET /api/heal/actions` - Recent heal actions
- `POST /api/heal/trigger` - Manual heal trigger

## Scheduled Jobs (Cron)

| Schedule | Task |
|----------|------|
| `*/5 * * * *` | Health check & self-healing |
| `*/15 * * * *` | Repo sync check |
| `0 * * * *` | Full agent status report |
| `0 */6 * * *` | Deep repo scrape |
| `0 0 * * *` | Daily cleanup & optimization |

## Setup

### Prerequisites

- Node.js 18+
- Cloudflare account with Workers, KV, D1, R2, and Queues enabled
- Wrangler CLI

### Installation

```bash
# Clone the repo
git clone https://github.com/BlackRoad-OS/youtube.git
cd youtube

# Install dependencies
npm install

# Login to Cloudflare
wrangler login

# Create required resources
wrangler kv:namespace create CACHE
wrangler kv:namespace create REPO_DATA
wrangler kv:namespace create AGENT_STATE
wrangler d1 create blackroad-agents
wrangler r2 bucket create blackroad-youtube-media
wrangler r2 bucket create blackroad-artifacts
wrangler queues create blackroad-tasks
wrangler queues create blackroad-sync

# Apply database schema
wrangler d1 execute blackroad-agents --file=schema.sql

# Set secrets
wrangler secret put GITHUB_TOKEN
wrangler secret put YOUTUBE_API_KEY
wrangler secret put WEBHOOK_SECRET
```

### Development

```bash
# Run locally
npm run dev

# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production

# View logs
npm run tail
```

### Scripts

```bash
# Check sync status
npm run sync:repos status

# Trigger full sync
npm run sync:repos sync

# Check system health
npm run sync:repos health

# View agent status
npm run sync:repos agents
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ENVIRONMENT` | Deployment environment | `development` |
| `LOG_LEVEL` | Logging level | `debug` |
| `BLACKROAD_ORG` | GitHub organization | `BlackRoad-OS` |
| `SELF_HEAL_ENABLED` | Enable self-healing | `true` |
| `AUTO_SYNC_ENABLED` | Enable auto-sync | `true` |
| `TRACKED_REPOS` | Comma-separated repo list | See wrangler.toml |
| `MAX_RETRY_ATTEMPTS` | Max task retries | `5` |
| `RETRY_BACKOFF_MS` | Retry backoff base | `2000` |

### Secrets

| Secret | Description |
|--------|-------------|
| `GITHUB_TOKEN` | GitHub PAT for API access |
| `YOUTUBE_API_KEY` | YouTube Data API key |
| `WEBHOOK_SECRET` | GitHub webhook secret |

## Self-Healing

The self-healer agent provides automatic issue resolution:

1. **Detection**: Health checks run every 5 minutes
2. **Analysis**: Failed checks trigger healing logic
3. **Action**: Appropriate healing action is selected
4. **Execution**: Action is executed with retry support
5. **Circuit Breaker**: Prevents cascading failures

### Healing Actions

- `restart` - Restart a failed agent
- `retry` - Retry failed tasks
- `rollback` - Request deployment rollback
- `alert` - Send alert notification
- `scale` - Request scaling (platform-handled)

## Cross-Repo Cohesion

The repo scraper analyzes all BlackRoad repos for:

- Shared interfaces and types
- Common dependencies
- Structural patterns
- API consistency

This ensures all repos in the BlackRoad ecosystem work together cohesively.

## GitHub Actions

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `deploy.yml` | Push to main/release | CI/CD pipeline |
| `sync.yml` | Schedule/dispatch | Cross-repo sync |
| `health-check.yml` | Every 5 min | Health monitoring |

## License

MIT

---

⬛⬜🛣️ Built with BlackRoad
