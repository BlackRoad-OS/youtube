// ⬛⬜🛣️ BlackRoad Queue Handlers
// Process background tasks from Cloudflare Queues

import { Env } from '../types/env';

interface QueueMessage {
  taskId?: string;
  type: string;
  priority?: number;
  repo?: string;
  payload?: Record<string, unknown>;
}

export async function handleQueue(
  batch: MessageBatch,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  console.log(`[Queue] Processing batch of ${batch.messages.length} messages`);

  for (const message of batch.messages) {
    try {
      const body = message.body as QueueMessage;

      console.log(`[Queue] Processing message: ${JSON.stringify(body)}`);

      switch (body.type) {
        case 'repo_scrape':
          await handleRepoScrape(env, body);
          break;

        case 'sync_check':
          await handleSyncCheck(env, body);
          break;

        case 'health_check':
          await handleHealthCheck(env, body);
          break;

        case 'self_heal':
          await handleSelfHeal(env, body);
          break;

        case 'release_update':
          await handleReleaseUpdate(env, body);
          break;

        case 'cohesion_analysis':
          await handleCohesionAnalysis(env, body);
          break;

        default:
          console.log(`[Queue] Unknown message type: ${body.type}`);
      }

      // Acknowledge successful processing
      message.ack();

      // Update task status if taskId provided
      if (body.taskId) {
        await updateTaskStatus(env, body.taskId, 'completed');
      }
    } catch (error) {
      console.error(`[Queue] Error processing message:`, error);

      // Retry the message
      message.retry();

      // Update task status to failed if taskId provided
      const body = message.body as QueueMessage;
      if (body.taskId) {
        await updateTaskStatus(env, body.taskId, 'failed', error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }
}

async function handleRepoScrape(env: Env, message: QueueMessage): Promise<void> {
  const repo = message.repo || message.payload?.repo as string;

  if (!repo) {
    throw new Error('No repo specified for scrape');
  }

  const scraperId = env.REPO_SCRAPER.idFromName(repo);
  const scraper = env.REPO_SCRAPER.get(scraperId);

  const response = await scraper.fetch(new Request('http://internal/scrape', {
    method: 'POST',
    body: JSON.stringify({ repo, org: env.BLACKROAD_ORG }),
  }));

  if (!response.ok) {
    throw new Error(`Scrape failed with status ${response.status}`);
  }

  console.log(`[Queue] Repo scrape completed for ${repo}`);
}

async function handleSyncCheck(env: Env, message: QueueMessage): Promise<void> {
  const syncId = env.SYNC_MANAGER.idFromName('main');
  const syncManager = env.SYNC_MANAGER.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/check'));

  if (!response.ok) {
    throw new Error(`Sync check failed with status ${response.status}`);
  }

  const updates = await response.json() as { updates: Record<string, { hasUpdate?: boolean }> };

  // If updates detected, trigger full sync
  const hasUpdates = Object.values(updates.updates || {}).some(u => u?.hasUpdate);

  if (hasUpdates) {
    await env.SYNC_QUEUE_PRODUCER.send({
      type: 'full_sync',
      priority: 2,
    });
  }

  console.log(`[Queue] Sync check completed, updates: ${hasUpdates}`);
}

async function handleHealthCheck(env: Env, message: QueueMessage): Promise<void> {
  const coordinatorId = env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('http://internal/health'));

  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }

  const health = await response.json() as { overall: string };

  // Store result
  await env.AGENT_STATE.put('health:queue', JSON.stringify({
    ...health,
    checkedAt: new Date().toISOString(),
    source: 'queue',
  }));

  console.log(`[Queue] Health check completed: ${health.overall}`);
}

async function handleSelfHeal(env: Env, message: QueueMessage): Promise<void> {
  const healerId = env.SELF_HEALER.idFromName('main');
  const healer = env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('http://internal/trigger', {
    method: 'POST',
    body: JSON.stringify(message.payload || {}),
  }));

  if (!response.ok) {
    throw new Error(`Self-heal failed with status ${response.status}`);
  }

  console.log(`[Queue] Self-heal action completed`);
}

async function handleReleaseUpdate(env: Env, message: QueueMessage): Promise<void> {
  const repo = message.repo;

  if (!repo) {
    throw new Error('No repo specified for release update');
  }

  console.log(`[Queue] Processing release update for ${repo}`);

  // Trigger repo scrape to get latest
  await env.TASK_QUEUE_PRODUCER.send({
    type: 'repo_scrape',
    repo,
    priority: 1,
  });

  // Store release event
  await env.AGENT_STATE.put(`release:${repo}:latest`, JSON.stringify({
    repo,
    payload: message.payload,
    processedAt: new Date().toISOString(),
  }));

  // Trigger cohesion analysis
  await env.SYNC_QUEUE_PRODUCER.send({
    type: 'cohesion_analysis',
    priority: 3,
  });

  console.log(`[Queue] Release update processed for ${repo}`);
}

async function handleCohesionAnalysis(env: Env, message: QueueMessage): Promise<void> {
  const scraperId = env.REPO_SCRAPER.idFromName('main');
  const scraper = env.REPO_SCRAPER.get(scraperId);

  const response = await scraper.fetch(new Request('http://internal/analyze-cohesion'));

  if (!response.ok) {
    throw new Error(`Cohesion analysis failed with status ${response.status}`);
  }

  const analysis = await response.json();

  // Store analysis
  await env.REPO_DATA.put('cohesion:queue-analysis', JSON.stringify({
    ...analysis,
    analyzedAt: new Date().toISOString(),
    source: 'queue',
  }));

  console.log(`[Queue] Cohesion analysis completed`);
}

async function updateTaskStatus(
  env: Env,
  taskId: string,
  status: 'completed' | 'failed',
  error?: string
): Promise<void> {
  const taskQueueId = env.TASK_QUEUE.idFromName('main');
  const taskQueue = env.TASK_QUEUE.get(taskQueueId);

  await taskQueue.fetch(new Request(`http://internal/task/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status, error }),
  }));
}
