import { defineTool } from 'eve/tools';
import { z } from 'zod';

/**
 * Deterministic liveness tool. The model sees this as `ping` (from the
 * filename). It runs in the app runtime with full `process.env`, so its reply
 * proves the runtime executed an authored tool during a durable turn.
 */
export default defineTool({
  description: 'Liveness check. Returns a fixed token proving the runtime executed a tool.',
  inputSchema: z.object({}),
  async execute() {
    return { ok: true, token: 'istatym-pong', runtime: 'self-hosted-eve' };
  },
});
