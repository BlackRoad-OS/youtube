// ⬛⬜🛣️ BlackRoad YouTube Workers - Main Entry Point
// Cloudflare Workers with Agent Automation & Self-Healing

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { Env, HealthStatus, AgentTask } from './types/env';
import { handleScheduled } from './handlers/scheduled';
import { handleQueue } from './handlers/queue';

// Re-export Durable Objects
export { AgentCoordinator } from './agents/coordinator';
export { RepoScraperAgent } from './agents/repo-scraper';
export { TaskQueueAgent } from './agents/task-queue';
export { SelfHealerAgent } from './agents/self-healer';
export { SyncManagerAgent } from './agents/sync-manager';

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', cors());
app.use('*', logger());

// ============================================
// Health & Status Endpoints
// ============================================

app.get('/', (c) => {
  return c.json({
    name: '⬛⬜🛣️ BlackRoad YouTube Workers',
    version: '1.0.0',
    status: 'operational',
    environment: c.env.ENVIRONMENT,
    endpoints: {
      health: '/api/health',
      agents: '/api/agents',
      repos: '/api/repos',
      tasks: '/api/tasks',
      sync: '/api/sync',
    },
  });
});

app.get('/api/health', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const health = await coordinator.fetch(new Request('http://internal/health'));
  const healthData: HealthStatus = await health.json();

  const statusCode = healthData.overall === 'healthy' ? 200 :
                     healthData.overall === 'degraded' ? 207 : 503;

  return c.json(healthData, statusCode);
});

// ============================================
// Agent Management Endpoints
// ============================================

app.get('/api/agents', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('http://internal/agents'));
  return c.json(await response.json());
});

app.get('/api/agents/:name', async (c) => {
  const name = c.param('name');
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request(`http://internal/agents/${name}`));
  return c.json(await response.json());
});

app.post('/api/agents/:name/trigger', async (c) => {
  const name = c.param('name');
  const body = await c.req.json().catch(() => ({}));

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request(`http://internal/agents/${name}/trigger`, {
    method: 'POST',
    body: JSON.stringify(body),
  }));

  return c.json(await response.json());
});

// ============================================
// Repository Scraping Endpoints
// ============================================

app.get('/api/repos', async (c) => {
  const repos = c.env.TRACKED_REPOS.split(',');
  const repoData = await Promise.all(
    repos.map(async (repo) => {
      const data = await c.env.REPO_DATA.get(`repo:${repo}`, 'json');
      return { name: repo, data };
    })
  );

  return c.json({ repos: repoData });
});

app.get('/api/repos/:name', async (c) => {
  const name = c.param('name');
  const data = await c.env.REPO_DATA.get(`repo:${name}`, 'json');

  if (!data) {
    return c.json({ error: 'Repository not found' }, 404);
  }

  return c.json(data);
});

app.post('/api/repos/:name/scrape', async (c) => {
  const name = c.param('name');

  const scraperId = c.env.REPO_SCRAPER.idFromName(name);
  const scraper = c.env.REPO_SCRAPER.get(scraperId);

  const response = await scraper.fetch(new Request('http://internal/scrape', {
    method: 'POST',
    body: JSON.stringify({ repo: name, org: c.env.BLACKROAD_ORG }),
  }));

  return c.json(await response.json());
});

app.get('/api/repos/:name/interfaces', async (c) => {
  const name = c.param('name');
  const data = await c.env.REPO_DATA.get(`interfaces:${name}`, 'json');

  return c.json({ repo: name, interfaces: data || [] });
});

// ============================================
// Task Management Endpoints
// ============================================

app.get('/api/tasks', async (c) => {
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') || '50');

  let query = 'SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?';
  const params: (string | number)[] = [limit];

  if (status) {
    query = 'SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?';
    params.unshift(status);
  }

  const result = await c.env.DB.prepare(query).bind(...params).all();

  return c.json({ tasks: result.results });
});

app.post('/api/tasks', async (c) => {
  const body = await c.req.json<Partial<AgentTask>>();

  const taskId = c.env.TASK_QUEUE.idFromName('main');
  const taskQueue = c.env.TASK_QUEUE.get(taskId);

  const response = await taskQueue.fetch(new Request('http://internal/enqueue', {
    method: 'POST',
    body: JSON.stringify(body),
  }));

  return c.json(await response.json(), 201);
});

app.get('/api/tasks/:id', async (c) => {
  const id = c.param('id');

  const result = await c.env.DB.prepare(
    'SELECT * FROM agent_tasks WHERE id = ?'
  ).bind(id).first();

  if (!result) {
    return c.json({ error: 'Task not found' }, 404);
  }

  return c.json(result);
});

// ============================================
// Sync & Webhooks
// ============================================

app.post('/api/sync/webhook', async (c) => {
  const signature = c.req.header('x-hub-signature-256');
  const event = c.req.header('x-github-event');
  const body = await c.req.json();

  // Validate webhook signature if secret is configured
  if (c.env.WEBHOOK_SECRET && signature) {
    // TODO: Implement signature validation
  }

  const syncId = c.env.SYNC_MANAGER.idFromName('main');
  const syncManager = c.env.SYNC_MANAGER.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/webhook', {
    method: 'POST',
    headers: { 'x-github-event': event || 'unknown' },
    body: JSON.stringify(body),
  }));

  return c.json(await response.json());
});

app.post('/api/sync/trigger', async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const syncId = c.env.SYNC_MANAGER.idFromName('main');
  const syncManager = c.env.SYNC_MANAGER.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/trigger', {
    method: 'POST',
    body: JSON.stringify(body),
  }));

  return c.json(await response.json());
});

// ============================================
// Self-Healing Endpoints
// ============================================

app.get('/api/heal/status', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('main');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('http://internal/status'));
  return c.json(await response.json());
});

app.get('/api/heal/actions', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('main');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('http://internal/actions'));
  return c.json(await response.json());
});

app.post('/api/heal/trigger', async (c) => {
  const body = await c.req.json();

  const healerId = c.env.SELF_HEALER.idFromName('main');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('http://internal/trigger', {
    method: 'POST',
    body: JSON.stringify(body),
  }));

  return c.json(await response.json());
});

// ============================================
// Exports
// ============================================

export default {
  fetch: app.fetch,

  // Scheduled/Cron handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await handleScheduled(event, env, ctx);
  },

  // Queue consumer handler
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
    await handleQueue(batch, env, ctx);
  },
};
