import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AssistantContext } from '../tool-kit';

/**
 * The receipt tools: match_receipt (a `readTool`), and create_purchase_order,
 * create_supplier, create_product (each a `writeTool` — previewed, then
 * committed with the confirmation token). See `../receipt/` for the matching.
 */
export function registerReceiptTools(
  _server: McpServer,
  _ctx: AssistantContext,
): void {}
