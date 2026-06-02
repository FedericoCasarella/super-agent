// Output variable schema per trigger type. Used by VariableTextarea to suggest
// {{trigger.X}} tokens the user can drop into step configs.

export type VarDef = { key: string; label: string; sample?: string };

export const TRIGGER_OUTPUTS: Record<string, VarDef[]> = {
  'whatsapp.received': [
    { key: 'trigger.msg.text',         label: 'Testo messaggio',     sample: 'Ciao, sei in ufficio?' },
    { key: 'trigger.msg.chat_jid',     label: 'Chat JID',            sample: '39348...@s.whatsapp.net' },
    { key: 'trigger.msg.sender_name',  label: 'Nome mittente',       sample: 'Marco Rossi' },
    { key: 'trigger.msg.sender_phone', label: 'Telefono mittente',   sample: '393481234567' },
    { key: 'trigger.msg.is_group',     label: 'È gruppo',            sample: 'false' },
    { key: 'trigger.msg.ts',           label: 'Timestamp',           sample: '2026-06-02T10:30:00Z' },
    { key: 'trigger.msg.person_slug',  label: 'Slug persona (brain)' },
  ],
  'telegram.received': [
    { key: 'trigger.text',     label: 'Testo messaggio' },
    { key: 'trigger.chatId',   label: 'Chat id' },
    { key: 'trigger.messageId',label: 'Message id' },
  ],
  'email.received': [
    { key: 'trigger.account',   label: 'Account email' },
    { key: 'trigger.from',      label: 'Mittente' },
    { key: 'trigger.subject',   label: 'Oggetto' },
    { key: 'trigger.body',      label: 'Corpo email' },
    { key: 'trigger.messageId', label: 'Message-ID' },
  ],
  'voice.received': [
    { key: 'trigger.transcript', label: 'Trascrizione' },
  ],
  'schedule.datetime': [
    { key: 'trigger.at', label: 'Data/ora trigger' },
  ],
  'schedule.cron': [
    { key: 'trigger.cron', label: 'Espressione cron' },
  ],
  'agent.finished': [
    { key: 'trigger.agentName', label: 'Nome agente' },
    { key: 'trigger.title',     label: 'Titolo task' },
    { key: 'trigger.status',    label: 'Stato' },
  ],
  'brain.node_added': [
    { key: 'trigger.path', label: 'Path nota' },
    { key: 'trigger.kind', label: 'Tipo nodo' },
  ],
  'task.triggered': [
    { key: 'trigger.taskId', label: 'Task id' },
    { key: 'trigger.name',   label: 'Nome task' },
  ],
  'perk.fired': [
    { key: 'trigger.name', label: 'Nome perk' },
  ],
  'team.fired': [
    { key: 'trigger.teamId', label: 'Team id' },
    { key: 'trigger.taskId', label: 'Task id' },
  ],
};

// Globals always available
export const GLOBAL_VARS: VarDef[] = [
  { key: 'now',  label: 'Adesso (ISO)' },
  { key: 'date', label: 'Data oggi (YYYY-MM-DD)' },
];

// Union of vars from a list of trigger types, deduped by key.
export function varsForTriggers(triggerTypes: string[]): VarDef[] {
  const map = new Map<string, VarDef>();
  for (const v of GLOBAL_VARS) map.set(v.key, v);
  for (const t of triggerTypes) {
    for (const v of TRIGGER_OUTPUTS[t] ?? []) {
      if (!map.has(v.key)) map.set(v.key, v);
    }
  }
  return [...map.values()];
}
