module.exports = {
  apps: [
    {
      name: 'relay-app',
      script: 'npm',
      args: 'start',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/relay-app-error.log',
      out_file: './logs/relay-app-out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 5,
    },
    {
      name: 'relay-relay',
      script: 'npm',
      args: 'run relay',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        // server/relay-node.ts reads RELAY_PORT before falling back to PORT
        // — using the same var name docker-compose.yml uses keeps the two
        // deployment paths consistent instead of relying on the fallback.
        RELAY_PORT: 8080,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/relay-relay-error.log',
      out_file: './logs/relay-relay-out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 5,
    },
  ],
};
