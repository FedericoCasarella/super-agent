export type AgentReport = {
  scanned?: number;
  classified?: number;
  protected?: number;
  public?: number;
  skipped?: number;
  errors?: number;
  details?: any[];
  durationMs?: number;
  [k: string]: any;
};

export type Lang = 'it' | 'en';

export type InternalAgent = {
  name: string;
  title: string;
  description: string;
  defaultHour: number;
  defaultMinute: number;
  run: (userId: number) => Promise<AgentReport>;
  // Human-friendly summary for the Telegram notification (localized).
  humanize?: (report: AgentReport, lang: Lang, status: 'ok' | 'error') => string;
};
