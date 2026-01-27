// ⬛⬜🛣️ BlackRoad Scheduled Job Handlers
// Cron-triggered tasks for agents

import { Env } from '../types/env';

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const cronExpression = event.cron;

  console.log(`[Scheduled] Cron triggered: ${cronExpression} at ${new Date(event.scheduledTime).toISOString()}`);

  try {
    switch (cronExpression) {
      // Every 5 minutes - Health check and self-healing
      case '*/5 * * * *':
        await runHealthCheck(env, ctx);
        break;

      // Every 15 minutes - Repo sync check
      case '*/15 * * * *':
        await runSyncCheck(env, ctx);
        break;

      // Every hour - Full agent status report
      case '0 * * * *':
        await runAgentStatusReport(env, ctx);
        break;

      // Every 6 hours - Deep repo scrape
      case '0 */6 * * *':
        await runDeepRepoScrape(env, ctx);
        break;

      // Daily at midnight - Cleanup and optimization
      case '0 0 * * *':
        await runDailyCleanup(env, ctx);
        break;

      default:
        console.log(`[Scheduled] Unknown cron expression: ${cronExpression}`);
    }
  } catch (error) {
    console.error(`[Scheduled] Error in cron ${cronExpression}:`, error);

    // Trigger self-healing for scheduled job failures
    if (env.SELF_HEAL_ENABLED === 'true') {
      ctx.waitUntil(triggerSelfHeal(env, 'scheduled_job_failure', cronExpression));
    }
  }
}

async function runHealthCheck(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running health check...');

  const coordinatorId = env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('http://internal/health'));
  const health = await response.json();

  console.log(`[Scheduled] Health check result: ${JSON.stringify(health)}`);

  // Store health check result
  await env.AGENT_STATE.put('health:latest', JSON.stringify({
    ...health,
    checkedAt: new Date().toISOString(),
    cron: '*/5 * * * *',
  }));
}

async function runSyncCheck(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running sync check...');

  if (env.AUTO_SYNC_ENABLED !== 'true') {
    console.log('[Scheduled] Auto-sync is disabled, skipping...');
    return;
  }

  const syncId = env.SYNC_MANAGER.idFromName('main');
  const syncManager = env.SYNC_MANAGER.get(syncId);

  const response = await syncManager.fetch(new Request('http://internal/check'));
  const updates = await response.json();

  console.log(`[Scheduled] Sync check result: ${JSON.stringify(updates)}`);

  // Store sync check result
  await env.AGENT_STATE.put('sync:latest', JSON.stringify({
    ...updates,
    checkedAt: new Date().toISOString(),
    cron: '*/15 * * * *',
  }));

  // If there are updates, trigger sync
  const hasUpdates = Object.values(updates.updates || {}).some(
    (u: unknown) => (u as { hasUpdate?: boolean })?.hasUpdate
  );

  if (hasUpdates) {
    console.log('[Scheduled] Updates detected, triggering sync...');
    ctx.waitUntil(
      syncManager.fetch(new Request('http://internal/trigger', {
        method: 'POST',
        body: JSON.stringify({ full: true }),
      }))
    );
  }
}

async function runAgentStatusReport(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Generating agent status report...');

  const coordinatorId = env.AGENT_COORDINATOR.idFromName('main');
  const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

  const agentsResponse = await coordinator.fetch(new Request('http://internal/agents'));
  const agents = await agentsResponse.json();

  const taskQueueId = env.TASK_QUEUE.idFromName('main');
  const taskQueue = env.TASK_QUEUE.get(taskQueueId);

  const tasksResponse = await taskQueue.fetch(new Request('http://internal/status'));
  const tasks = await tasksResponse.json();

  const report = {
    generatedAt: new Date().toISOString(),
    agents,
    tasks,
    environment: env.ENVIRONMENT,
  };

  console.log(`[Scheduled] Agent status report: ${JSON.stringify(report)}`);

  // Store report
  await env.AGENT_STATE.put('report:latest', JSON.stringify(report));

  // Also store in D1 for history
  try {
    await env.DB.prepare(`
      INSERT INTO agent_reports (id, generated_at, agents, tasks, environment)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      report.generatedAt,
      JSON.stringify(agents),
      JSON.stringify(tasks),
      env.ENVIRONMENT
    ).run();
  } catch (error) {
    console.error('[Scheduled] Failed to store report in D1:', error);
  }
}

async function runDeepRepoScrape(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running deep repo scrape...');

  const scraperId = env.REPO_SCRAPER.idFromName('main');
  const scraper = env.REPO_SCRAPER.get(scraperId);

  const response = await scraper.fetch(new Request('http://internal/scrape-all', {
    method: 'POST',
  }));

  const result = await response.json();

  console.log(`[Scheduled] Deep scrape result: ${JSON.stringify(result)}`);

  // Analyze cohesion after deep scrape
  const cohesionResponse = await scraper.fetch(new Request('http://internal/analyze-cohesion'));
  const cohesion = await cohesionResponse.json();

  await env.REPO_DATA.put('cohesion:analysis', JSON.stringify({
    ...cohesion,
    analyzedAt: new Date().toISOString(),
    cron: '0 */6 * * *',
  }));

  console.log(`[Scheduled] Cohesion analysis: ${JSON.stringify(cohesion)}`);
}

async function runDailyCleanup(env: Env, ctx: ExecutionContext): Promise<void> {
  console.log('[Scheduled] Running daily cleanup...');

  // Clean up old tasks from D1
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(`
      DELETE FROM agent_tasks
      WHERE status = 'completed' AND completed_at < ?
    `).bind(thirtyDaysAgo).run();

    console.log('[Scheduled] Cleaned up old completed tasks');
  } catch (error) {
    console.error('[Scheduled] Failed to cleanup tasks:', error);
  }

  // Clean up old reports
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(`
      DELETE FROM agent_reports
      WHERE generated_at < ?
    `).bind(sevenDaysAgo).run();

    console.log('[Scheduled] Cleaned up old reports');
  } catch (error) {
    console.error('[Scheduled] Failed to cleanup reports:', error);
  }

  // Store cleanup record
  await env.AGENT_STATE.put('cleanup:latest', JSON.stringify({
    completedAt: new Date().toISOString(),
    cron: '0 0 * * *',
  }));

  console.log('[Scheduled] Daily cleanup completed');
}

async function triggerSelfHeal(env: Env, trigger: string, target: string): Promise<void> {
  const healerId = env.SELF_HEALER.idFromName('main');
  const healer = env.SELF_HEALER.get(healerId);

  await healer.fetch(new Request('http://internal/trigger', {
    method: 'POST',
    body: JSON.stringify({
      action: 'alert',
      target,
      reason: trigger,
    }),
  }));
}
