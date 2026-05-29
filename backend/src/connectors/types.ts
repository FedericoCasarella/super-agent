export type ConnectorConfigField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'accounts' | 'select';
  required?: boolean;
  placeholder?: string;
  options?: string[]; // for type='select'
};

export type ConnectorManifest = {
  name: string;
  title: string;
  description: string;
  schedule?: string; // cron expression default
  configSchema: ConnectorConfigField[];
};

export type ConnectorContext = {
  userId: number;
  config: Record<string, any>;
  state: Record<string, any>;
  saveState: (next: Record<string, any>) => Promise<void>;
  log: (msg: string, meta?: any) => void;
};

export type ConnectorTool = {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema
  handler: (ctx: ConnectorContext, args: any) => Promise<any>;
};

export type ConnectorTestResult = { ok: boolean; detail?: string; error?: string };

export type Connector = {
  manifest: ConnectorManifest;
  onTick?: (ctx: ConnectorContext) => Promise<void>;
  onMessage?: (ctx: ConnectorContext, message: string) => Promise<void>;
  tools?: ConnectorTool[];
  // Optional live connectivity check against the provider, given a (possibly unsaved) config.
  test?: (cfg: Record<string, any>) => Promise<ConnectorTestResult>;
};
