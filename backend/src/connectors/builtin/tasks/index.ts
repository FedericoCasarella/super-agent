import type { Connector } from '../../types.js';
import { query } from '../../../db/index.js';
import { refreshTasks, runTaskById } from '../../../scheduler/tasks.js';
import cron from 'node-cron';

const connector: Connector = {
  manifest: {
    name: 'tasks',
    title: 'Scheduled Tasks',
    description: 'Create, list, update and delete recurring jobs. Action types: notify, prompt, tool.',
    configSchema: [],
  },
  tools: [
    {
      name: 'create',
      description: 'Create a scheduled task. Cron 5-field format.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cron: { type: 'string' },
          action_type: { type: 'string', enum: ['notify', 'prompt', 'tool'] },
          action_payload: { type: 'object' },
          enabled: { type: 'boolean', default: true },
        },
        required: ['name', 'cron', 'action_type', 'action_payload'],
        additionalProperties: false,
      },
      handler: async (ctx, { name, cron: expr, action_type, action_payload, enabled = true }) => {
        if (!cron.validate(expr)) throw new Error(`invalid cron: ${expr}`);
        const rows = await query<{ id: number }>(
          `INSERT INTO scheduled_tasks(user_id,name,cron,action_type,action_payload,enabled)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [ctx.userId, name, expr, action_type, action_payload, enabled]
        );
        await refreshTasks();
        return { ok: true, id: rows[0]?.id };
      },
    },
    {
      name: 'list',
      description: 'List all scheduled tasks.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const rows = await query(
          `SELECT id::int, name, cron, action_type, action_payload, enabled, last_run_at, last_status, last_result
           FROM scheduled_tasks WHERE user_id=$1 ORDER BY id DESC`, [ctx.userId]
        );
        return rows;
      },
    },
    {
      name: 'update',
      description: 'Update fields of a task.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' },
          cron: { type: 'string' },
          action_type: { type: 'string', enum: ['notify', 'prompt', 'tool'] },
          action_payload: { type: 'object' },
          enabled: { type: 'boolean' },
        },
        required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, p: any) => {
        if (p.cron && !cron.validate(p.cron)) throw new Error(`invalid cron: ${p.cron}`);
        const fields: string[] = [];
        const vals: any[] = [];
        let i = 2;
        for (const k of ['name', 'cron', 'action_type', 'action_payload', 'enabled']) {
          if (p[k] !== undefined) { fields.push(`${k}=$${++i}`); vals.push(p[k]); }
        }
        if (!fields.length) return { ok: true, noop: true };
        await query(`UPDATE scheduled_tasks SET ${fields.join(',')}, updated_at=now() WHERE id=$1 AND user_id=$2`, [p.id, ctx.userId, ...vals]);
        await refreshTasks();
        return { ok: true };
      },
    },
    {
      name: 'delete',
      description: 'Delete a task.',
      inputSchema: {
        type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, { id }) => {
        await query('DELETE FROM scheduled_tasks WHERE id=$1 AND user_id=$2', [id, ctx.userId]);
        await refreshTasks();
        return { ok: true };
      },
    },
    {
      name: 'run_now',
      description: 'Trigger a task immediately.',
      inputSchema: {
        type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, { id }) => {
        await runTaskById(ctx.userId, id);
        return { ok: true };
      },
    },
  ],
};

export default connector;
