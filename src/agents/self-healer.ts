// ⬛⬜🛣️ BlackRoad Self-Healer Agent
// Automatic issue detection, resolution, and self-healing capabilities

import { Env, SelfHealAction, HealthStatus, HealthCheck } from '../types/env';

interface HealerState {
  actions: Map<string, SelfHealAction>;
  healCount: number;
  lastHealAttempt: string;
  consecutiveFailures: number;
  circuitOpen: boolean;
  circuitOpenedAt: string | null;
}

export class SelfHealerAgent implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private healerState: HealerState;

  // Circuit breaker settings
  private readonly CIRCUIT_THRESHOLD = 5;
  private readonly CIRCUIT_RESET_MS = 60000; // 1 minute

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.healerState = {
      actions: new Map(),
      healCount: 0,
      lastHealAttempt: '',
      consecutiveFailures: 0,
      circuitOpen: false,
      circuitOpenedAt: null,
    };

    // Load persisted state
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<HealerState>('healerState');
      if (stored) {
        this.healerState = {
          actions: new Map(Object.entries(stored.actions || {})),
          healCount: stored.healCount || 0,
          lastHealAttempt: stored.lastHealAttempt || '',
          consecutiveFailures: stored.consecutiveFailures || 0,
          circuitOpen: stored.circuitOpen || false,
          circuitOpenedAt: stored.circuitOpenedAt || null,
        };
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Get healer status
      if (path === '/status' && request.method === 'GET') {
        return this.handleStatus();
      }

      // Get all actions
      if (path === '/actions' && request.method === 'GET') {
        return this.handleGetActions();
      }

      // Manual trigger heal action
      if (path === '/trigger' && request.method === 'POST') {
        const body = await request.json();
        return this.handleManualTrigger(body);
      }

      // Auto-heal based on health status
      if (path === '/auto-heal' && request.method === 'POST') {
        const body = await request.json();
        return this.handleAutoHeal(body);
      }

      // Reset circuit breaker
      if (path === '/reset-circuit' && request.method === 'POST') {
        return this.handleResetCircuit();
      }

      // Specific action status
      const actionMatch = path.match(/^\/action\/([^/]+)$/);
      if (actionMatch && request.method === 'GET') {
        return this.handleGetAction(actionMatch[1]);
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

  private handleStatus(): Response {
    // Check if circuit should be reset
    if (this.healerState.circuitOpen && this.healerState.circuitOpenedAt) {
      const elapsed = Date.now() - new Date(this.healerState.circuitOpenedAt).getTime();
      if (elapsed > this.CIRCUIT_RESET_MS) {
        this.healerState.circuitOpen = false;
        this.healerState.circuitOpenedAt = null;
        this.healerState.consecutiveFailures = 0;
      }
    }

    const recentActions = Array.from(this.healerState.actions.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);

    return new Response(JSON.stringify({
      enabled: this.env.SELF_HEAL_ENABLED === 'true',
      circuitBreaker: {
        open: this.healerState.circuitOpen,
        consecutiveFailures: this.healerState.consecutiveFailures,
        threshold: this.CIRCUIT_THRESHOLD,
        openedAt: this.healerState.circuitOpenedAt,
      },
      stats: {
        totalHealAttempts: this.healerState.healCount,
        lastAttempt: this.healerState.lastHealAttempt,
        actionsCount: this.healerState.actions.size,
      },
      recentActions,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetActions(): Response {
    const actions = Array.from(this.healerState.actions.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return new Response(JSON.stringify({ actions }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetAction(id: string): Response {
    const action = this.healerState.actions.get(id);

    if (!action) {
      return new Response(JSON.stringify({ error: 'Action not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(action), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleManualTrigger(body: {
    action: SelfHealAction['action'];
    target: string;
    reason?: string;
  }): Promise<Response> {
    if (this.healerState.circuitOpen) {
      return new Response(JSON.stringify({
        error: 'Circuit breaker is open',
        resetAt: new Date(
          new Date(this.healerState.circuitOpenedAt!).getTime() + this.CIRCUIT_RESET_MS
        ).toISOString(),
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const action: SelfHealAction = {
      id: crypto.randomUUID(),
      trigger: body.reason || 'manual',
      action: body.action,
      target: body.target,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    const result = await this.executeHealAction(action);

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleAutoHeal(body: { health: HealthStatus; timestamp: string }): Promise<Response> {
    if (this.env.SELF_HEAL_ENABLED !== 'true') {
      return new Response(JSON.stringify({
        healed: false,
        reason: 'Self-healing is disabled',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (this.healerState.circuitOpen) {
      return new Response(JSON.stringify({
        healed: false,
        reason: 'Circuit breaker is open',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { health } = body;
    const actionsToTake: SelfHealAction[] = [];

    // Analyze failed checks and determine healing actions
    for (const check of health.checks) {
      if (check.status === 'fail') {
        const action = this.determineHealAction(check);
        if (action) {
          actionsToTake.push(action);
        }
      }
    }

    // Analyze agent health
    for (const agent of health.agents) {
      if (agent.status === 'error') {
        actionsToTake.push({
          id: crypto.randomUUID(),
          trigger: `agent-error:${agent.name}`,
          action: 'restart',
          target: agent.name,
          status: 'pending',
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Execute all healing actions
    const results: Array<{ action: SelfHealAction; success: boolean }> = [];

    for (const action of actionsToTake) {
      const result = await this.executeHealAction(action);
      results.push({ action: result, success: result.status === 'completed' });
    }

    this.healerState.healCount++;
    this.healerState.lastHealAttempt = new Date().toISOString();
    await this.persistState();

    return new Response(JSON.stringify({
      healed: true,
      actionsCount: actionsToTake.length,
      results,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private determineHealAction(check: HealthCheck): SelfHealAction | null {
    const baseAction: Omit<SelfHealAction, 'action' | 'target'> = {
      id: crypto.randomUUID(),
      trigger: `check-failed:${check.name}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    // KV failures - retry connection
    if (check.name.includes('kv')) {
      return {
        ...baseAction,
        action: 'retry',
        target: 'kv-namespace',
      };
    }

    // D1 failures - alert and retry
    if (check.name.includes('d1')) {
      return {
        ...baseAction,
        action: 'alert',
        target: 'd1-database',
      };
    }

    // Agent failures - restart the agent
    if (check.name.includes('agent')) {
      const agentName = check.name.replace('agent-', '');
      return {
        ...baseAction,
        action: 'restart',
        target: agentName,
      };
    }

    return null;
  }

  private async executeHealAction(action: SelfHealAction): Promise<SelfHealAction> {
    action.status = 'executing';
    action.executedAt = new Date().toISOString();
    this.healerState.actions.set(action.id, action);

    try {
      switch (action.action) {
        case 'restart':
          await this.executeRestart(action.target);
          action.result = 'Agent restart triggered';
          break;

        case 'retry':
          await this.executeRetry(action.target);
          action.result = 'Retry operation completed';
          break;

        case 'rollback':
          await this.executeRollback(action.target);
          action.result = 'Rollback initiated';
          break;

        case 'alert':
          await this.executeAlert(action);
          action.result = 'Alert sent';
          break;

        case 'scale':
          // Scaling is handled by Cloudflare automatically
          action.result = 'Scaling request noted (handled by platform)';
          break;

        default:
          action.result = 'Unknown action type';
      }

      action.status = 'completed';
      this.healerState.consecutiveFailures = 0;
    } catch (error) {
      action.status = 'failed';
      action.result = error instanceof Error ? error.message : 'Unknown error';
      this.healerState.consecutiveFailures++;

      // Open circuit breaker if threshold reached
      if (this.healerState.consecutiveFailures >= this.CIRCUIT_THRESHOLD) {
        this.healerState.circuitOpen = true;
        this.healerState.circuitOpenedAt = new Date().toISOString();
      }
    }

    await this.persistState();
    return action;
  }

  private async executeRestart(target: string): Promise<void> {
    // Trigger a task to restart/reinitialize the agent
    const taskQueueId = this.env.TASK_QUEUE.idFromName('main');
    const taskQueue = this.env.TASK_QUEUE.get(taskQueueId);

    await taskQueue.fetch(new Request('http://internal/enqueue', {
      method: 'POST',
      body: JSON.stringify({
        type: 'self_heal',
        priority: 1, // High priority
        payload: {
          action: 'restart',
          target,
          timestamp: new Date().toISOString(),
        },
      }),
    }));

    // Also notify coordinator to mark agent as recovering
    const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('main');
    const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('http://internal/status', {
      method: 'POST',
      body: JSON.stringify({ agent: target, status: 'recovering' }),
    }));
  }

  private async executeRetry(target: string): Promise<void> {
    // Retry failed tasks for the target
    const taskQueueId = this.env.TASK_QUEUE.idFromName('main');
    const taskQueue = this.env.TASK_QUEUE.get(taskQueueId);

    await taskQueue.fetch(new Request('http://internal/retry-failed', {
      method: 'POST',
    }));
  }

  private async executeRollback(target: string): Promise<void> {
    // Store rollback request - actual rollback would need deployment integration
    await this.env.AGENT_STATE.put(`rollback:${target}`, JSON.stringify({
      requested: new Date().toISOString(),
      target,
      status: 'pending',
    }));

    // This would integrate with your deployment system
    console.log(`Rollback requested for: ${target}`);
  }

  private async executeAlert(action: SelfHealAction): Promise<void> {
    // Store alert for external monitoring
    const alertKey = `alert:${action.id}`;
    await this.env.AGENT_STATE.put(alertKey, JSON.stringify({
      ...action,
      severity: 'high',
      notifiedAt: new Date().toISOString(),
    }), {
      expirationTtl: 86400, // 24 hours
    });

    // Could integrate with external alerting (PagerDuty, Slack, etc.)
    console.log(`Alert: ${action.trigger} - Target: ${action.target}`);
  }

  private handleResetCircuit(): Response {
    this.healerState.circuitOpen = false;
    this.healerState.circuitOpenedAt = null;
    this.healerState.consecutiveFailures = 0;

    this.persistState();

    return new Response(JSON.stringify({
      reset: true,
      message: 'Circuit breaker has been reset',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async persistState(): Promise<void> {
    await this.state.storage.put('healerState', {
      actions: Object.fromEntries(this.healerState.actions),
      healCount: this.healerState.healCount,
      lastHealAttempt: this.healerState.lastHealAttempt,
      consecutiveFailures: this.healerState.consecutiveFailures,
      circuitOpen: this.healerState.circuitOpen,
      circuitOpenedAt: this.healerState.circuitOpenedAt,
    });
  }

  // Periodic self-check via alarm
  async alarm(): Promise<void> {
    // Auto-check and heal if enabled
    if (this.env.SELF_HEAL_ENABLED === 'true' && !this.healerState.circuitOpen) {
      const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('main');
      const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

      const healthResponse = await coordinator.fetch(new Request('http://internal/health'));
      const health: HealthStatus = await healthResponse.json();

      if (health.overall === 'unhealthy') {
        await this.handleAutoHeal({ health, timestamp: new Date().toISOString() });
      }
    }

    // Schedule next check in 5 minutes
    await this.state.storage.setAlarm(Date.now() + 300000);
  }
}
