const buildSha = process.env.BUILD_SHA;

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
      // PM2 keeps any variable it started the app with; a BUILD_SHA exported only by the deploy
      // shell survives every later reload and /readyz then reports the first commit forever.
      env: {
        NODE_ENV: 'production',
        ...(buildSha ? { BUILD_SHA: buildSha } : {}),
      },
    },
  ],
};
