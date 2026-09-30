'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { Fleet } = require('./fleet');
const metrics = require('./metrics');
const { classifyReport, isSuspicious } = require('./classify');

const PORT = Number(process.env.PORT ?? 8080);
const LOG_FILE = process.env.LOG_FILE ?? path.join(__dirname, '..', 'logs', 'telemetry.log');
const BUILD = process.env.BUILD ?? 'beta-20260926-6';
const SPEED = Number(process.env.SPEED ?? 10);

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

const log = (obj) => {
  const line = JSON.stringify(obj);
  stream.write(line + '\n');
  if (process.env.LOG_STDOUT !== '0') process.stdout.write(line + '\n');
  
  // Chaque evenement journalise alimente aussi les metriques Prometheus
  if (obj.event === 'perf_spike') {
    // build vient du client pour /api/reports : on refuse les valeurs au mauvais format
    const build = /^beta-\d{8}-\d+$/.test(obj.report?.build) ? obj.report.build : 'invalid';
    metrics.perfReportsTotal.inc({ cause: classifyReport(obj.report), build, source: obj.source ?? 'fleet' });
    if (isSuspicious(obj.report)) metrics.perfReportsSuspiciousTotal.inc({ build });
  } else if (obj.event === 'game_completed') {
    const map = obj.server.map;
    metrics.gamesCompletedTotal.inc({ map, quarantined: String(obj.server.quarantined) });
    // Simulation acceleree : 1 s reelle = SPEED s de jeu
    const durationS = (Date.now() - obj.server.createdAt) / 1000 * SPEED;
    metrics.gameDurationSeconds.observe({ map }, durationS);
  }
};

const fleet = new Fleet({
  build: BUILD,
  gamesPerMinute: Number(process.env.GAMES_PER_MINUTE ?? 4),
  speed: SPEED,
  incidents: process.env.INCIDENTS !== '0',
});
fleet.on('log', log);
fleet.start();

// La jauge est recalculee a chaque lecture de /metrics
metrics.gamesInProgress.collect = () => metrics.gamesInProgress.set(fleet.liveGames().length);

const app = createApp({ fleet, log });
const server = app.listen(PORT, () => {
  log({ ts: new Date().toISOString(), level: 'info', event: 'startup', port: PORT, build: BUILD });
});

const shutdown = () => {
  fleet.stop();
  server.close(() => stream.end(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
