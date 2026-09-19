import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AssistantContext } from '../tool-kit';

/**
 * The cycle tools: create_cycle, add_shipping_leg, transition_cycle,
 * verify_stock. Each changes something, so each is a `writeTool`.
 */
export function registerCycleTools(
  _server: McpServer,
  _ctx: AssistantContext,
): void {}
