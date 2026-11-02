module.exports = {
  apps: [
    {
      name: 'f1genz-sapo-api',
      script: 'dist/main.js',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--env-file=.env --dns-result-order=ipv4first',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_memory_restart: '512M',
      time: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
