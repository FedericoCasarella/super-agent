// Plugin esempio. Stessa shape dei connettori builtin.
// Export default = oggetto Connector.
export default {
  manifest: {
    name: 'hello',
    title: 'Hello World plugin',
    description: 'Plugin di esempio. Saluta.',
    configSchema: [],
  },
  tools: [
    {
      name: 'say',
      description: 'Ritorna un saluto personalizzato.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Nome da salutare' } },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (_ctx, { name }) => {
        return { greeting: `Ciao ${name}, plugin caricato!` };
      },
    },
  ],
};
