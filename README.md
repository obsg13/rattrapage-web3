# game-telemetry-demo

Service de télémétrie d'un jeu de tir multijoueur web (parties 1 à 2 joueurs contre bots).

## Lancer

```bash
npm ci
npm start                  # API sur :8080, logs JSON lines dans logs/telemetry.log et stdout
npm test
npm run lint
npm run loadgen -- --rps 5 --burst-every 120 --burst-rps 80
```

Variables d'environnement : `PORT`, `LOG_FILE`, `LOG_STDOUT` (0 pour couper stdout), `BUILD`, `GAMES_PER_MINUTE`, `SPEED`, `INCIDENTS` (0 pour désactiver).

## API

| méthode | route | rôle |
|---|---|---|
| GET | `/healthz` | santé |
| GET | `/api/games` | parties en cours |
| POST | `/api/reports` | ingestion d'un rapport client `{ report, server }` |

## Logs en direct

Une ligne JSON par événement : `startup`, `game_created`, `game_completed`, `perf_spike`, `http_request`, `http_error`.

## Extrait historique

`data/admin-export-2026-09-20_26.log` : export brut de la console d'administration (production, 7 jours). Format texte multi-lignes, un en-tête lisible suivi d'un bloc JSON :

```
Performance spike <serverId> · <date locale>
<reason> · <frameMs>ms <reason>
{ "report": {...}, "server": {...} }

Game completed <serverId> · <date locale>
<map> · <score>
{ ...état final du serveur... }
```

## Installation avec la stack d'observabilité

Prérequis: Docker Desktop (avec docker compose).

```bash
docker compose up -d --build
```

Cette commande lance le service, le générateur de charge et toute la stack d'observabilité:

| Service | Rôle | Adresse |
|---|---|---|
| telemetry | API du jeu et simulation des parties | http://localhost:8080 |
| loadgen | générateur de charge | - |
| loki | stockage des logs | http://localhost:3100 |
| promtail | envoie les logs du service vers Loki | - |
| ingest-history | importe l'export historique dans Loki, puis s'arrête (`exited (0)` est normal) | - |
| prometheus | métriques et alertes | http://localhost:9090 |
| grafana | dashboards | http://localhost:3000 |

Pour tout arrêter: `docker compose down`

### Grafana

- Adresse: http://localhost:3000, identifiants `admin` / `admin`
- 3 dashboards (menu Dashboards): Santé du service, Performance côté joueur, Activité de jeu et intégrité des parties
- Les panneaux de l'historique affichent les 30 derniers jours. Après le 19/10/2026, choisir dans le sélecteur de temps la plage du 2026-09-19 00:00 au 2026-09-27 00:00 (UTC) pour revoir l'export. Les panneaux en direct sont alors vides, c'est normal.

### Prometheus

- Métriques du service: http://localhost:8080/metrics
- Alertes: http://localhost:9090/alerts
- Recording rules: http://localhost:9090/rules

### Réimporter l'historique

```bash
docker compose down -v
docker compose up -d --build
```

Attendre environ 30min après l'import avant de compter les données dans Grafana.

### Rapport et captures

Le rapport est dans `docs/rapport.pdf` et les captures d'écran dans `docs/captures/`.
