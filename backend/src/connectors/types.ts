export type ConnectorConfigField = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'accounts';
  required?: boolean;
  placeholder?: string;
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

export type Connector = {
  manifest: ConnectorManifest;
  onTick?: (ctx: ConnectorContext) => Promise<void>;
  onMessage?: (ctx: ConnectorContext, message: string) => Promise<void>;
  // Fired after the user saves the connector config (PUT /connectors/:name).
  // Use for side-effects that depend on the saved value: registering external
  // resources, refreshing caches, etc.
  onConfigSaved?: (ctx: ConnectorContext) => Promise<void>;
  tools?: ConnectorTool[];
};
