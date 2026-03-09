// ⬛⬜🛣️ BlackRoad Agent Coordinator
// Central orchestration for all agents

import { Env, HealthStatus, AgentHealth } from '../types/env';

interface CoordinatorState {
  agents: Map<string, AgentHealth>;
  lastHealthCheck: string;
  startedAt: string;
}

export class AgentCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private coordinatorState: CoordinatorState;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.coordinatorState = {
      agents: new Map(),
      lastHealthCheck: new Date().toISOString(),
      startedAt: new Date().toISOString(),
    };

    // Initialize agent registry
    this.initializeAgents();
  }

  private initializeAgents() {
    const agentNames = [
      'coordinator',
      'repo-scraper',
      'task-queue',
      'self-healer',
      'sync-manager',
    ];

    for (const name of agentNames) {
      this.coordinatorState.agents.set(name, {
        name,
        status: 'idle',
        lastActivity: new Date().toISOString(),
        taskCount: 0,
        errorCount: 0,
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === '/health') {
        return this.handleHealthCheck();
      }

      // List all agents
      if (path === '/agents' && request.method === 'GET') {
        return this.handleListAgents();
      }

      // Get specific agent
      const agentMatch = path.match(/^\/agents\/([^/]+)$/);
      if (agentMatch && request.method === 'GET') {
        return this.handleGetAgent(agentMatch[1]);
      }

      // Trigger agent
      const triggerMatch = path.match(/^\/agents\/([^/]+)\/trigger$/);
      if (triggerMatch && request.method === 'POST') {
        const body = await request.json();
        return this.handleTriggerAgent(triggerMatch[1], body);
      }

      // Update agent status (internal)
      if (path === '/status' && request.method === 'POST') {
        const body = await request.json();
        return this.handleStatusUpdate(body);
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

  private async handleHealthCheck(): Promise<Response> {
    const checks = await this.runHealthChecks();
    const agentHealthList = Array.from(this.coordinatorState.agents.values());

    const failedChecks = checks.filter(c => c.status === 'fail').length;
    const warnChecks = checks.filter(c => c.status === 'warn').length;
    const errorAgents = agentHealthList.filter(a => a.status === 'error').length;

    let overall: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (failedChecks > 0 || errorAgents > 1) {
      overall = 'unhealthy';
    } else if (warnChecks > 0 || errorAgents === 1) {
      overall = 'degraded';
    }

    const health: HealthStatus = {
      overall,
      timestamp: new Date().toISOString(),
      checks,
      agents: agentHealthList,
    };

    this.coordinatorState.lastHealthCheck = health.timestamp;

    // If unhealthy and self-heal is enabled, trigger healing
    if (overall === 'unhealthy' && this.env.SELF_HEAL_ENABLED === 'true') {
      await this.triggerSelfHeal(health);
    }

    return new Response(JSON.stringify(health), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async runHealthChecks() {
    const checks = [];
    const startTime = Date.now();

    // Check KV connectivity
    try {
      await this.env.CACHE.get('health-check-test');
      checks.push({
        name: 'kv-cache',
        status: 'pass' as const,
        latencyMs: Date.now() - startTime,
      });
    } catch (error) {
      checks.push({
        name: 'kv-cache',
        status: 'fail' as const,
        message: error instanceof Error ? error.message : 'KV check failed',
      });
    }

    // Check D1 connectivity
    try {
      const d1Start = Date.now();
      await this.env.DB.prepare('SELECT 1').first();
      checks.push({
        name: 'd1-database',
        status: 'pass' as const,
        latencyMs: Date.now() - d1Start,
      });
    } catch (error) {
      checks.push({
        name: 'd1-database',
        status: 'fail' as const,
        message: error instanceof Error ? error.message : 'D1 check failed',
      });
    }

    // Check R2 connectivity
    try {
      const r2Start = Date.now();
      await this.env.MEDIA_BUCKET.head('health-check-test');
      checks.push({
        name: 'r2-storage',
        status: 'pass' as const,
        latencyMs: Date.now() - r2Start,
      });
    } catch (error) {
      // R2 returns error for non-existent objects, but connectivity is fine
      checks.push({
        name: 'r2-storage',
        status: 'pass' as const,
        latencyMs: Date.now() - startTime,
      });
    }

    // Check agent states
    for (const [name, agent] of this.coordinatorState.agents) {
      const agentInactive = new Date().getTime() - new Date(agent.lastActivity).getTime() > 300000; // 5 min

      if (agent.status === 'error') {
        checks.push({
          name: `agent-${name}`,
          status: 'fail' as const,
          message: 'Agent in error state',
        });
      } else if (agentInactive && agent.status !== 'idle') {
        checks.push({
          name: `agent-${name}`,
          status: 'warn' as const,
          message: 'Agent inactive for >5 minutes',
        });
      } else {
        checks.push({
          name: `agent-${name}`,
          status: 'pass' as const,
        });
      }
    }

    return checks;
  }

  private async triggerSelfHeal(health: HealthStatus) {
    const healerId = this.env.SELF_HEALER.idFromName('main');
    const healer = this.env.SELF_HEALER.get(healerId);

    await healer.fetch(new Request('http://internal/auto-heal', {
      method: 'POST',
      body: JSON.stringify({ health, timestamp: new Date().toISOString() }),
    }));
  }

  private handleListAgents(): Response {
    const agents = Array.from(this.coordinatorState.agents.values());
    return new Response(JSON.stringify({
      agents,
      count: agents.length,
      coordinatorStarted: this.coordinatorState.startedAt,
      lastHealthCheck: this.coordinatorState.lastHealthCheck,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleGetAgent(name: string): Response {
    const agent = this.coordinatorState.agents.get(name);

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(agent), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTriggerAgent(name: string, body: Record<string, unknown>): Promise<Response> {
    const agent = this.coordinatorState.agents.get(name);

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Route to appropriate Durable Object
    let targetDO: DurableObjectNamespace;
    switch (name) {
      case 'repo-scraper':
        targetDO = this.env.REPO_SCRAPER;
        break;
      case 'task-queue':
        targetDO = this.env.TASK_QUEUE;
        break;
      case 'self-healer':
        targetDO = this.env.SELF_HEALER;
        break;
      case 'sync-manager':
        targetDO = this.env.SYNC_MANAGER;
        break;
      default:
        return new Response(JSON.stringify({ error: 'Agent cannot be triggered directly' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
    }

    const doId = targetDO.idFromName('main');
    const doInstance = targetDO.get(doId);

    const response = await doInstance.fetch(new Request('http://internal/trigger', {
      method: 'POST',
      body: JSON.stringify(body),
    }));

    // Update agent status
    agent.status = 'active';
    agent.lastActivity = new Date().toISOString();
    agent.taskCount++;

    return new Response(JSON.stringify({
      triggered: true,
      agent: name,
      response: await response.json(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private handleStatusUpdate(body: { agent: string; status: AgentHealth['status']; error?: string }): Response {
    const agent = this.coordinatorState.agents.get(body.agent);

    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    agent.status = body.status;
    agent.lastActivity = new Date().toISOString();

    if (body.status === 'error') {
      agent.errorCount++;
    }

    return new Response(JSON.stringify({ updated: true, agent }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
