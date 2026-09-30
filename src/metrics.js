'use strict';

const client = require('prom-client');

// Registre unique : tout ce qui est expose sur GET /metrics
const register = new client.Registry();

// Metriques du processus Node (CPU, memoire, event loop..)
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Nombre de requetes HTTP traitees',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree des requetes HTTP en secondes',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const gamesInProgress = new client.Gauge({
  name: 'games_in_progress',
  help: 'Nombre de parties en cours',
  registers: [register],
});

const gamesCompletedTotal = new client.Counter({
  name: 'games_completed_total',
  help: 'Nombre de parties terminees',
  labelNames: ['map', 'quarantined'],
  registers: [register],
});

const gameDurationSeconds = new client.Histogram({
  name: 'game_duration_seconds',
  help: 'Duree des parties en secondes de jeu (simulation)',
  labelNames: ['map'],
  buckets: [60, 120, 300, 600, 900],
  registers: [register],
});

const perfReportsTotal = new client.Counter({
  name: 'perf_reports_total',
  help: 'Nombre de rapports de pic de performance',
  labelNames: ['cause', 'build', 'source'],
  registers: [register],
});

const perfReportsSuspiciousTotal = new client.Counter({
  name: 'perf_reports_suspicious_total',
  help: 'Nombre de rapports physiquement impossibles',
  labelNames: ['build'],
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  gamesInProgress,
  gamesCompletedTotal,
  gameDurationSeconds,
  perfReportsTotal,
  perfReportsSuspiciousTotal,
};
