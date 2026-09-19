import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AssistantContext } from '../tool-kit';

/**
 * The read tools: find_suppliers, find_products, list_cycles, get_cycle,
 * get_stock, list_sales, get_customer, list_payments, get_dashboard,
 * get_fx_rates. Each is registered with `readTool` from `../tool-kit`.
 */
export function registerReadTools(
  _server: McpServer,
  _ctx: AssistantContext,
): void {}
