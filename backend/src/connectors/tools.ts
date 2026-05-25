import { listConnectors, buildContext } from './registry.js';
import type { ConnectorTool } from './types.js';

export type RegisteredTool = ConnectorTool & { connector: string; fullName: string };

export function listTools(): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  for (const c of listConnectors()) {
    for (const t of c.tools ?? []) {
      out.push({ ...t, connector: c.manifest.name, fullName: `${c.manifest.name}_${t.name}` });
    }
  }
  return out;
}

export async function invokeTool(userId: number, fullName: string, args: any): Promise<any> {
  const tool = listTools().find((t) => t.fullName === fullName);
  if (!tool) throw new Error(`unknown tool: ${fullName}`);
  const ctx = await buildContext(userId, tool.connector);
  return tool.handler(ctx, args ?? {});
}
