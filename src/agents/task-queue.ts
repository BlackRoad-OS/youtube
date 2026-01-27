// ⬛⬜🛣️ BlackRoad Task Queue Agent
// Manages task scheduling, prioritization, and execution

import { Env, AgentTask, AgentTaskType, TaskStatus } from '../types/env';

interface QueueState {
  tasks: Map<string, AgentTask>;
  processing: Set<string>;
  stats: {
    totalEnqueued: number;
    totalCompleted: number;
    totalFailed: number;
    totalRetried: number;
  };
}

export class TaskQueueAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private queueState: QueueState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.queueState = {
      tasks: new Map(),
      processing: new Set(),
      stats: {
        totalEnqueued: 0,
        totalCompleted: 0,
        totalFailed: 0,
        totalRetried: 0,
      },
    };

    // Load persisted state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<QueueState>('queueState');
      if (stored) {
        this.queueState = {
          tasks: new Map(Object.entries(stored.tasks || {})),
          processing: new Set(stored.processing || []),
          stats: stored.stats || this.queueState.stats,
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Enqueue new task
      if (path === '/enqueue' && request.method === 'POST') {
        const body = await request.json();
        return this.handleEnqueue(body);
      }

      // Get queue status
      if (path === '/status' && request.method === 'GET') {
        return this.handleStatus();
      }

      // Get specific task
      const taskMatch = path.match(/^\/task\/([^/]+)$/);
      if (taskMatch && request.method === 'GET') {
        return this.handleGetTask(taskMatch[1]);
      }

      // Update task status
      if (taskMatch && request.method === 'PATCH') {
        const body = await request.json();
        return this.handleUpdateTask(taskMatch[1], body);
      }

      // Process next task
      if (path === '/process' && request.method === 'POST') {
        return this.handleProcessNext();
      }

      // Trigger (for coordinator)
      if (path === '/trigger' && request.method === 'POST') {
        return this.handleProcessNext();
      }

      // Retry failed tasks
      if (path === '/retry-failed' && request.method === 'POST') {
        return this.handleRetryFailed();
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleEnqueue(body: Partial<AgentTask>): Promise<Response> {
    const task: AgentTask = {
      id: crypto.randomUUID(),
      type: body.type || 'health_check',
      status: 'pending',
      priority: body.priority || 5,
      payload: body.payload || {},
      retryCount: 0,
      maxRetries: body.maxRetries || parseInt(this.env.MAX_RETRY_ATTEMPTS) || 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Store in memory
    this.queueState.tasks.set(task.id, task);
    this.queueState.stats.totalEnqueued++;

    // Persist to D1
    await this.persistTaskToD1(task);

    // Also send to Cloudflare Queue for distributed processing
    await this.env.TASK_QUEUE_PRODUCER.send({
      taskId: task.id,
      type: task.type,
      priority: task.priority,
    });

    // Persist state
    await this.persistState();

    return new Response(JSON.stringify({
      success: true,
      task,
    }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async persistTaskToD1(task: AgentTask): Promise<void> {
    try {
      await this.env.DB.prepare(`
        INSERT INTO agent_tasks (id, type, status, priority, payload, retry_count, max_retries, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          priority = excluded.priority,
          payload = excluded.payload,
          retry_count = excluded.retry_count,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          error = excluded.error,
          result = excluded.result
      `).bind(
        task.id,
        task.type,
        task.status,
        task.priority,
        JSON.stringify(task.payload),
        task.retryCount,
        task.maxRetries,
        task.createdAt,
        task.updatedAt
      ).run();
    } catch (error) {
      console.error('Failed to persist task to D1:', error);
    }
  }

  private handleStatus(): Response {
    const pending = Array.from(this.queueState.tasks.values())
      .filter(t => t.status === 'pending').length;
    const running = this.queueState.processing.size;
    const failed = Array.from(this.queueState.tasks.values())
      .filter(t => t.status === 'failed').length;

    return new Response(JSON.stringify({
      queue: {
        pending,
        running,
        failed,
        total: this.queueState.tasks.size,
      },
      stats: this.queueState.stats,
      processingIds: Array.from(this.queueState.processing),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetTask(taskId: string): Response {
    const task = this.queueState.tasks.get(taskId);

    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(task), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleUpdateTask(taskId: string, updates: Partial<AgentTask>): Promise<Response> {
    const task = this.queueState.tasks.get(taskId);

    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update task
    Object.assign(task, updates, { updatedAt: new Date().toISOString() });

    // Handle status transitions
    if (updates.status === 'completed') {
      task.completedAt = new Date().toISOString();
      this.queueState.processing.delete(taskId);
      this.queueState.stats.totalCompleted++;
    } else if (updates.status === 'failed') {
      this.queueState.processing.delete(taskId);
      this.queueState.stats.totalFailed++;

      // Auto-retry if within limits
      if (task.retryCount < task.maxRetries) {
        task.status = 'retrying';
        task.retryCount++;
        this.queueState.stats.totalRetried++;

        // Re-enqueue with backoff
        const backoffMs = parseInt(this.env.RETRY_BACKOFF_MS) * Math.pow(2, task.retryCount);
        await this.state.storage.setAlarm(Date.now() + backoffMs);
      }
    } else if (updates.status === 'running') {
      this.queueState.processing.add(taskId);
    }

    // Persist
    await this.persistTaskToD1(task);
    await this.persistState();

    return new Response(JSON.stringify({ success: true, task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleProcessNext(): Promise<Response> {
    // Get highest priority pending task
    const pendingTasks = Array.from(this.queueState.tasks.values())
      .filter(t => t.status === 'pending' || t.status === 'retrying')
      .sort((a, b) => a.priority - b.priority);

    if (pendingTasks.length === 0) {
      return new Response(JSON.stringify({
        processed: false,
        message: 'No pending tasks'
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const task = pendingTasks[0];
    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    this.queueState.processing.add(task.id);

    // Process based on task type
    try {
      const result = await this.executeTask(task);
      task.status = 'completed';
      task.result = result;
      task.completedAt = new Date().toISOString();
      this.queueState.stats.totalCompleted++;
      this.queueState.processing.delete(task.id);
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : 'Unknown error';
      this.queueState.processing.delete(task.id);

      // Will be retried via handleUpdateTask logic
      if (task.retryCount < task.maxRetries) {
        task.status = 'retrying';
        task.retryCount++;
        this.queueState.stats.totalRetried++;
      } else {
        this.queueState.stats.totalFailed++;
      }
    }

    await this.persistTaskToD1(task);
    await this.persistState();

    return new Response(JSON.stringify({
      processed: true,
      task,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async executeTask(task: AgentTask): Promise<Record<string, unknown>> {
    switch (task.type) {
      case 'repo_scrape':
        return this.executeRepoScrape(task);
      case 'sync_check':
        return this.executeSyncCheck(task);
      case 'health_check':
        return this.executeHealthCheck(task);
      case 'self_heal':
        return this.executeSelfHeal(task);
      default:
        return { executed: true, type: task.type };
    }
  }

  private async executeRepoScrape(task: AgentTask): Promise<Record<string, unknown>> {
    const repo = task.payload.repo as string || 'youtube';
    const scraperId = this.env.REPO_SCRAPER.idFromName(repo);
    const scraper = this.env.REPO_SCRAPER.get(scraperId);

    const response = await scraper.fetch(new Request('http://internal/scrape', {
      method: 'POST',
      body: JSON.stringify({ repo, org: this.env.BLACKROAD_ORG }),
    }));

    return response.json();
  }

  private async executeSyncCheck(task: AgentTask): Promise<Record<string, unknown>> {
    const syncId = this.env.SYNC_MANAGER.idFromName('main');
    const syncManager = this.env.SYNC_MANAGER.get(syncId);

    const response = await syncManager.fetch(new Request('http://internal/check'));
    return response.json();
  }

  private async executeHealthCheck(task: AgentTask): Promise<Record<string, unknown>> {
    const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('main');
    const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

    const response = await coordinator.fetch(new Request('http://internal/health'));
    return response.json();
  }

  private async executeSelfHeal(task: AgentTask): Promise<Record<string, unknown>> {
    const healerId = this.env.SELF_HEALER.idFromName('main');
    const healer = this.env.SELF_HEALER.get(healerId);

    const response = await healer.fetch(new Request('http://internal/auto-heal', {
      method: 'POST',
      body: JSON.stringify(task.payload),
    }));

    return response.json();
  }

  private async handleRetryFailed(): Promise<Response> {
    const failedTasks = Array.from(this.queueState.tasks.values())
      .filter(t => t.status === 'failed' && t.retryCount < t.maxRetries);

    for (const task of failedTasks) {
      task.status = 'retrying';
      task.retryCount++;
      task.updatedAt = new Date().toISOString();
      this.queueState.stats.totalRetried++;
      await this.persistTaskToD1(task);
    }

    await this.persistState();

    return new Response(JSON.stringify({
      retriedCount: failedTasks.length,
      tasks: failedTasks.map(t => t.id),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('queueState', {
      tasks: Object.fromEntries(this.queueState.tasks),
      processing: Array.from(this.queueState.processing),
      stats: this.queueState.stats,
    });
  }

  // Alarm handler for retry backoff
  async alarm(): Promise<void> {
    await this.handleProcessNext();
  }
}
