## A - Preuves CI/CD et déploiement

Le pipeline `.github/workflows/ci.yml` tourne à chaque push: `lint-test` (ESLint + `node --test`), puis `build-scan-push` (build Docker, scan Trivy bloquant sur les failles `CRITICAL`, push Docker Hub).
- Un test cassé volontairement fait échouer `lint-test`, et `build-scan-push` n'est pas lancé (voir docs/captures/A3-ci-echec-tests.png). Après correction, tout repasse au vert (voir docs/captures/A3-ci-tests-corriges.png).
- Une image de base vulnérable fait échouer le scan Trivy sur `CVE-2026-59873` (CRITICAL). Le push n'est pas exécuté, donc l'image n'est jamais publiée (voir docs/captures/A3-ci-echec-vuln.png et docs/captures/A3-ci-echec-vuln-detail-trivy.png). Le retour à l'image saine repasse au vert (voir docs/captures/A3-ci-vuln-corrigee.png).
- La stack tourne en local avec `docker compose up -d --build`: 7 services, dont `ingest-history` en `exited (0)` car c'est un job unique (voir docs/captures/A4-docker-compose-ps.png).

## B3 - Rapport de qualité des données

Source: `data/admin-export-2026-09-20_26.log`, ingéré dans Loki par `scripts/ingest-history.js`
sous les labels `{job="telemetry-historique", event="game_completed"|"perf_spike"}`.
Chaque ligne Loki est un JSON: `headerId`, `summary`, `occurrence`, `orphan` (spikes), `report{...}` et `server{...}`.
`| json` aplatit les champs imbriqués avec `_`: `report.work.totalMs` devient `report_work_totalMs`.

Toutes les requêtes sont des requêtes **instantanées** évaluées au `2026-09-27T00:00:00.001Z`, avec une fenêtre `[8d]` qui couvre tout l'export (voir B3.8 pour les millisecondes).

### B3.1 - Volumétrie et période couverte

| Type | Lignes dans Loki | Doublons | Événements uniques |
|---|---|---|---|
| game_completed | 796 | 17 | 779 |
| perf_spike | 2148 | 38 | 2110 |
| **Total** | 2944 | 55 | **2889** |

```logql
sum by (event) (count_over_time({job="telemetry-historique"}[8d]))
sum by (event) (count_over_time({job="telemetry-historique"} | json | occurrence = 1 [8d]))
```

Période couverte: du 19/09/2026 22:31 UTC au 26/09/2026 22:04 UTC, soit 7 jours.

Preuve: `{job="telemetry-historique"}` dans Grafana Explore, en tri "Oldest first" puis "Newest first".

**Impact:** le nom du fichier ("20_26") ne correspond pas aux dates UTC: le premier événement date du 19/09 au soir en UTC (le 20/09 à Paris). Toutes les analyses doivent compter avec `occurrence = 1`, sinon elles surestiment d'environ 2%.

### B3.2 - Pièges de format et traitement par le script

| Piège | Exemple | Traitement dans `ingest-history.js` |
|---|---|---|
| Texte multi-lignes | en-tête `Game completed Ju73lcJQS · 9/27/2026, 12:04:13 AM`, puis résumé `harbor · 1 - 3`, puis JSON indenté sur plusieurs lignes | le fichier est coupé en blocs sur les lignes vides. Ligne 0 = en-tête (type + `headerId` + date), ligne 1 = `summary`, le reste = JSON. Chaque bloc devient une seule ligne JSON compacte. |
| Date US 12h AM/PM, heure de Paris | `9/27/2026, 12:04:13 AM` = 26/09 22:04:13 UTC | `parseDate` inverse mois/jour, gère AM/PM, puis ajoute `+02:00` (heure d'été de Paris). Loki reçoit donc un timestamp UTC. Limite: ce `+02:00` est codé en dur. |
| Ordre antichronologique | le fichier commence par l'événement le plus récent | `events.sort((a, b) => a.ts - b.ts)` avant l'envoi, car Loki attend des lignes dans l'ordre croissant pour chaque flux. |

**Impact:** sans ces conversions, les courbes seraient décalées de plusieurs heures et Loki refuserait une partie des lignes.

### B3.3 - Doublons exacts

55 blocs apparaissent au moins deux fois à l'identique : 17 `game_completed` et 38 `perf_spike`.
Le script numérote chaque copie dans `occurrence`. Sans cela, Loki fusionnerait en silence les lignes identiques qui ont le même timestamp, et on ne pourrait plus mesurer les doublons.

```logql
sum by (event) (count_over_time({job="telemetry-historique"} | json | occurrence > 1 [8d]))
```

**Impact:** on ajoute `| json | occurrence = 1` à toutes les requêtes d'analyse, sinon les taux de spikes et le nombre de parties sont gonflés.

### B3.4 - Changement de schéma v1 → v2

| Version | Build | `rttMs` | `work.stages.physics` | Rapports uniques |
|---|---|---|---|---|
| 1 | tous les builds avant 26/09-6 | `report.rttMs` (racine) | absent | 2085 |
| 2 | `beta-20260926-6` | `report.network.rttMs` | présent | 25 |

```logql
sum by (report_version) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 [8d]))
sum by (report_version) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | report_rttMs != "" [8d]))
```

La première requête compte les rapports par version (2085 en v1, 25 en v2). La seconde montre que `rttMs` à la racine n'existe que dans les rapports v1.

**Impact:** une courbe de latence construite uniquement sur `report_rttMs` s'arrête net au build 26-6, ce qui ressemble à une panne alors qu'il n'y en a pas. **Il faut lire le bon champ selon `report_version`.** Les 25 rapports v2 sont trop peu nombreux pour conclure sur `stages.physics`.

### B3.5 - Spikes orphelins

74 spikes uniques ont `orphan = true`: aucun `Game completed` de l'export ne correspond à leur `server.id`.

```logql
sum by (client) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | orphan = "true" | regexp `"id":"P-(?P<client>[0-9a-f]+)-` [8d]))
```

Ces parties ne sont pas situées au début ni à la fin de l'export: leurs absence ne vient donc pas de la coupure du fichier.
- 4 spikes (2 parties) se produisent juste avant le trou du 22/09 à 11:59 UTC (voir B3.6).
- Les 70 autres sont exactement les 70 rapports falsifiés du client `5e1f0c7a` (voir B3.7): chacun cite une partie qui n'existe nulle part. **Le client invente des parties: c'est une preuve de plus de falsification, pas des abandons.**

**Impact:** le script ne peut pas rattacher ces spikes à une carte finale ni à un score. On les garde pour mesurer les performances, mais on les exclut des analyses "par partie terminée".

### B3.6 - Trous dans les données

Requête en mode Range dans Grafana, avec un pas d'1h:

```logql
sum(count_over_time({job="telemetry-historique"} | json | occurrence = 1 [1h]))
```

- Nuits calmes (normal): une dizaine de silences d'environ 1h, toujours la nuit (entre 01h et 07h à Paris), quand l'activité tombe à environ 3 événements par heure. Aucune fenêtre d'1h n'est complètement vide.
- **Trou anormal le 22/09 de 11:59 à 14:14 UTC** (13:59 à 16:14 à Paris), soit plus de 2h. Ce sont les deux seules fenêtres d'1h à zéro de toute la période, et il manque environ 35 événements.

**Impact:** l'absence de spikes pendant ce trou ne prouve pas que le jeu allait bien. C'est une panne probable du serveur ou de la collecte. On exclut cette tranche des calculs de taux, et on signale les 2 parties orphelines interrompues juste avant.

### B3.7 - Incohérences: rapports falsifiés

Certains rapports sont physiquement impossibles: `fps > 144` alors que le jeu plafonne à 144, ou une image plus courte que le travail qu'elle contient (`frameMs < work.totalMs`).
Le script d'ingestion applique ces deux règles (fonction `isSuspicious`) et ajoute un champ `suspect` à chaque rapport. Il suffit ensuite de filtrer sur ce champ. L'id client est extrait de `report.id` (format `P-<client>-<seq>`) avec `regexp`.

```logql
sum by (client) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | suspect = "true" | regexp `"id":"P-(?P<client>[0-9a-f]+)-` [8d]))
```

Résultat: 70 rapports suspects, tous du client `5e1f0c7a` (sur 231 clients). **Ce sont tous les rapports de ce client: il n'envoie que des rapports falsifiés.**

**Impact:** ces 70 rapports faussent les moyennes de FPS et de temps de frame. On les exclut de l'analyse de performance, par exemple avec `!= "P-5e1f0c7a-"`, et on les traite comme un cas de sécurité (client modifié ou rapports forgés).

### B3.8 - Pièges de mesure dans Loki

J'ai constaté que le même comptage variait d'une ligne selon l'instant où je l'évaluais (2943 au lieu de 2944): une ligne horodatée pile à 22:00:00 UTC était oubliée, car Loki découpe les requêtes en tranches d'une heure.
J'ai aussi vu qu'après une ré-ingestion, les dernières lignes restaient invisibles pendant environ 30min (2096 spikes au lieu de 2110).

**Impact:** un petit écart de comptage peut venir de Loki et non des données. J'évalue donc toutes les requêtes à `2026-09-27T00:00:00.001Z`, et j'attends 30min après une ingestion avant de compter.

### Choix des labels et cardinalité

Loki indexe **uniquement les labels**, et chaque combinaison de labels crée un flux séparé. Un label doit donc avoir peu de valeurs possibles.
- `job` (2 valeurs: `telemetry`, `telemetry-historique`), `level` (`info`, `warn`) et `event` (5 types) restent sous la dizaine de valeurs. Ce sont les premiers filtres de toutes les requêtes, d'où leur place en labels (voir docs/captures/B1-loki-logs-direct.png).

- `report.id` (un par rapport, environ 2100), `client` (231), `server.id` (752 parties rien que dans les spikes) et `build` (une nouvelle valeur à chaque déploiement) créeraient des centaines ou milliers de petits flux. L'index grossirait et les requêtes ralentiraient.

Ces champs restent donc dans le contenu JSON, et on les filtre au moment de la requête avec `| json` (ou `|=` pour un filtre texte rapide).

## C1 - Justification des métriques

Le service expose ses métriques sur `GET /metrics` avec prom-client. Elles sont déclarées dans `src/metrics.js`, alimentées par le middleware HTTP (`src/app.js`) et par la fonction `log` (`src/server.js`).

| Métrique | Type | Labels (nombre de valeurs possibles) | Question à laquelle elle répond | Pourquoi ce type |
|---|---|---|---|---|
| `http_requests_total` | Counter | `method` (2 en pratique: GET, POST), `route` (5: 4 routes + `unknown`), `status` (200, 202, 400, 404,..) | Combien de requêtes par seconde, et quelle part en erreur ? | Le nombre ne fait que monter ; `rate()` donne le débit et le taux d'erreurs. |
| `http_request_duration_seconds` | Histogram | `method` (2), `route` (5) ; buckets de 5ms à 1s | Quel est le p95 de latence de chaque route ? | Une moyenne cache les requêtes lentes ; l'histogramme permet `histogram_quantile`. Pas de label `status` pour limiter le nombre de séries. |
| `games_in_progress` | Gauge | aucun (1 série) | Combien de parties tournent en ce moment ? | La valeur monte et descend. Elle est recalculée à chaque scrape via `collect()`, donc jamais périmée. |
| `games_completed_total` | Counter | `map` (5), `quarantined` (2) | Combien de parties se terminent, sur quelle carte, et combien sont mises en quarantaine ? | Compte des événements qui s'accumulent. |
| `game_duration_seconds` | Histogram | `map` (5) ; buckets 60, 120, 300, 600, 900 | Les parties ont-elles une durée normale, ou voit-on des parties très courtes (farming sur `vault`) ? | On lit la répartition par tranches: 60/120 isolent le farming (55-75s), 300 à 900 les parties normales (300-840s). Durée en temps de jeu. |
| `perf_reports_total` | Counter | `cause` (6), `build` (1 par build déployé + `invalid`), `source` (2: `fleet`, `ingest`) | Quelle cause de spike augmente, et depuis quel build ? | `rate()` par `cause` et `build` montre une régression, comme l'overlay depuis le build 24-3. |
| `perf_reports_suspicious_total` | Counter | `build` (1 par build + `invalid`) | Reçoit-on des rapports impossibles (fps > 144 ou frame plus courte que son travail) ? | Un compteur suffit pour déclencher une alerte ; le détail (quel client) se cherche dans Loki. |
| Métriques par défaut (`process_*`, `nodejs_*`) | Counter, Gauge et Histogram selon la métrique | peu de labels, valeurs fixes (exemple: type de GC, espace du heap) | Le processus Node est-il saturé: CPU, mémoire, event loop bloquée ? | Fournies par `collectDefaultMetrics`. `nodejs_eventloop_lag_seconds` est utile ici car `POST /api/reports` fait du travail synchrone qui bloque l'event loop. |

**Cardinalité:** chaque combinaison de labels crée une série dans Prometheus, donc un label doit avoir un petit nombre de valeurs connues à l'avance.
Le label `route` utilise le modèle de route Express (`req.route.path`) et non l'URL: une URL inconnue ou inventée donne toujours `unknown` au lieu de créer une nouvelle série.
Pour `POST /api/reports`, le `build` est envoyé par le client, donc on le vérifie avec la regex `^beta-\d{8}-\d+$`. Sinon un client modifié (comme `5e1f0c7a`) pourrait inventer une valeur par rapport. Une valeur invalide devient `invalid`.
Enfin, il n'y a pas de label `client` (231 valeurs et plus) ni `server.id` (une valeur par partie, sans limite) : ces identifiants restent dans les logs, et on les retrouve dans Loki avec `| json`.

## C2 - Recording rules

Les 4 recording rules de `prometheus/rules/recording.yml` sont calculées par Prometheus toutes les minutes, sur une fenêtre de 5min, et nommées selon la convention `niveau:metrique:operation`. Les dashboards lisent directement le résultat au lieu de refaire le calcul à chaque affichage (voir docs/captures/C2-recording-rules.png).
- `route:http_requests:rate5m` (requêtes par seconde par route) et `job:http_requests_5xx:ratio_rate5m` (part des réponses 5xx, qui vaut 0 et non "No data" quand il n'y a aucune erreur) alimentent le dashboard **Santé du service**.
- `route:http_request_duration_seconds:p95_5m` (latence p95 par route, via `histogram_quantile`) est aussi dans **Santé du service**, à côté du trafic, pour voir si la latence monte avec la charge.
- `build_cause:perf_reports:ratio_rate5m` (part de chaque cause dans les rapports d'un build, dont la somme vaut 1) alimente le dashboard **Performance côté joueur**. En direct, le service ne reçoit que le build `beta-20260926-6`, donc la règle montre la part de chaque cause pour ce build. La comparaison entre builds, comme la hausse de l'overlay depuis le build 24-3, se fait sur l'historique dans Loki.

## D - Tableaux de bord

Les 3 dashboards sont provisionnés sous forme de code: au démarrage, Grafana relit les fichiers `grafana/dashboards/*.json` (déclarés dans `grafana/provisioning/dashboards/dashboards.yml`) et les datasources de `grafana/provisioning/datasources/datasources.yml`. Chaque panneau a une question pour titre et une phrase de description.
- **Santé du service** (en direct, Prometheus): trafic et latence p95 par route, part des 5xx, requêtes refusées en 4xx, service joignable, retard de l'event loop (voir docs/captures/D-sante-du-service.png).
- **Performance côté joueur**: part des causes de spikes en direct, puis sur l'historique Loki les spikes overlay par build, par heure, par écran et par navigateur, et la durée p95 des images par cause (voir docs/captures/D-performance-du-jeu.png). Dans le panneau des écrans, chaque barre se lit "bloom puis largeur" (exemple: `true 2560`).
- **Activité de jeu et intégrité des parties**: en direct, les parties en cours, les parties terminées par carte et les parties vault de moins de 120s face aux quarantaines; sur l'historique, le farming sur vault par heure, le client qui envoie des rapports impossibles et les spikes pendant un serveur saccadé (voir docs/captures/D-activite-et-integrite.png).

La plage par défaut est la dernière heure, et les panneaux historiques (Loki) affichent les 30 derniers jours. Après le 19/10/2026, pour revoir toute la semaine de l'export, choisir dans le sélecteur de temps la plage du 2026-09-19 00:00 au 2026-09-27 00:00 (UTC). Les panneaux en direct sont alors vides, ce qui est normal.


## E1 - Classification des spikes par cause

`scripts/ingest-history.js` applique `classifyReport` (`src/classify.js`) à chaque rapport de l'historique et ajoute le champ `cause`. Les règles sont testées dans l'ordre du tableau: la première qui correspond donne la cause.

| Cause | Signature dans le rapport | Règle de `classify.js` | Spikes uniques |
|---|---|---|---|
| network | le client signale un problème réseau | `reason === 'network'` | 92 |
| hidden | l'onglet est passé en arrière-plan | une activité `visibilityHidden` | 158 |
| shader | compilation de shaders (première capture ou nombreux nouveaux programmes) | `graphics.firstCapture` ou `graphics.newPrograms > 20` | 459 |
| overlay | le dessin de l'overlay prend presque toute l'image | `work.details.renderOverlay > 100` (ms) | 262 |
| world | la simulation du monde est lente | `work.details.worldDynamics > 30` (ms) | 20 |
| generic | aucune des règles précédentes | cas par défaut | 1119 |
| **Total** | | | **2110** |

```logql
sum by (cause) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 [8d]))
```

La capture docs/captures/E1-classification-par-cause.png affiche overlay = 261 au lieu de 262, à cause du piège de mesure décrit en B3.8.

## E2 - Analyse de l'historique

Toutes les requêtes sont de type Instant, évaluées au `2026-09-27T00:00:00.001Z` avec une fenêtre `[8d]` (heures en UTC).

### E2.1 - Dégradation liée à une version

| Build | Spikes | dont overlay | Part overlay |
|---|---|---|---|
| beta-20260919-2 | 641 | 5 | 1% |
| beta-20260922-1 | 625 | 4 | 1% |
| beta-20260924-3 | 578 | 190 | 33% |
| beta-20260926-5 | 171 | 59 | 35% |
| beta-20260926-6 | 25 | 4 | 16% |

- Le premier vrai rapport du build 24-3 arrive le jeudi 24/09 à 17:06 (rapports falsifiés exclus, voir E2.5), le premier spike overlay à 18:16. Une image dure alors environ 490ms (médiane).
- Spikes overlay par jour: au plus 2 jusqu'au 23/09, puis 18 le 24, 111 le 25 et 126 le 26.

```logql
sum by (report_build) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | suspect = "false" | cause = "overlay" [8d]))
/
sum by (report_build) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | suspect = "false" [8d]))
```

Preuve: docs/captures/D-performance-du-jeu.png (spikes overlay par build et par heure).

**La régression overlay arrive avec le build 24-3 et n'est pas corrigée dans 26-5 ni 26-6 (16% sur 25 rapports seulement).**

### E2.2 - Population touchée

- 248 des 253 spikes overlay depuis le build 24-3 viennent d'écrans d'au moins 2560px avec le bloom activé (249 sur 262 sur tout l'historique).
- 39 des 40 clients qui ont cette configuration et un build 24-3 ou plus récent sont touchés (sur 231 clients).
- Tous les navigateurs sont touchés (spikes overlay sur tout l'historique): 84 spikes sur Chrome, 80 sur Firefox, 59 sur Safari, 21 sur Edge et 18 sur Brave.

```logql
sum by (report_graphics_width, report_graphics_bloom) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | cause = "overlay" [8d]))
```

Preuve: docs/captures/D-performance-du-jeu.png (spikes overlay par écran et par navigateur).

**Le problème vient de la combinaison grand écran et bloom, pas du navigateur.**

### E2.3 - Phénomènes récurrents

- Sur 16 spikes, le serveur saccade (`tickGapMaxMs` au-dessus de 100ms, normalement environ 50ms), la nuit vers 01h les 21/09 et 23/09.
- Les 20 spikes world viennent tous de la carte foundry.

```logql
sum(count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | server_tickGapMaxMs > 100 [8d]))
```

Preuve: docs/captures/D-activite-et-integrite.png (spikes pendant un serveur saccadé).

**Ce sont deux problèmes séparés de l'overlay: le serveur ralentit la nuit, et la simulation du monde est lente sur la carte foundry.**

### E2.4 - Parties suspectes (farming)

- 83 parties vault durent moins de 120s, toutes gagnées 3-0, sur deux nuits: du 22/09 23:14 au 23/09 vers 01:30, et du 24/09 vers 22h au 25/09 vers 00:30.
- Seules 17 sont mises en quarantaine (1 sur 5, et environ 50 sur 150 en direct le 01/10): dans `src/fleet.js`, une partie farmée n'a que 30% de chances d'être mise en quarantaine, et c'est la partie qui est marquée, pas le joueur.

```logql
sum by (quarantined) (count_over_time({job="telemetry-historique", event="game_completed"} | json | occurrence = 1 | map = "vault" | durationS < 120 [8d]))
```

Preuve: docs/captures/D-activite-et-integrite.png (parties vault de moins de 120s et quarantaines).

**La quarantaine laisse passer la plupart des parties farmées et ne sanctionne jamais le joueur.**

### E2.5 - Données falsifiées

- Les 70 rapports du client `5e1f0c7a` (voir B3.7) citent des parties inventées (les orphelins de B3.5) et déclarent tous le build 24-3.
- Le premier date du 24/09 à 07:35, soit environ 9h avant le vrai déploiement de ce build (17:06).

```logql
sum by (report_build) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | suspect = "true" [8d]))
```

Preuve: docs/captures/D-activite-et-integrite.png (clients qui envoient des rapports impossibles).

**Ces rapports sont forgés: je les exclus des analyses, sinon ils avancent la date du build 24-3 et baissent sa part d'overlay.**

## E3 - Alertes

J'ai défini 5 alertes dans `prometheus/rules/alerts.yml`, à partir des recording rules de C2. Sur la capture docs/captures/E3-alertes.png, OverlaySpikeRegression (build 26-6, environ 20%) et VaultFarming (épisode de farming en cours) sont en Firing, les 3 autres sont Inactive.

| Alerte | Condition | Durée (`for`) | Justification du seuil |
|---|---|---|---|
| OverlaySpikeRegression | part overlay d'un build > 10% | 10min | environ 1% sur les builds sains, 33% sur le build 24-3: 10% sépare bien les deux |
| VaultFarming | plus de 5 parties vault de moins de 120s en 15min | 5min | une partie normale dure au moins 300s, une partie farmée environ 60s |
| SuspiciousReports | au moins un rapport impossible en 10min | 0min | un client honnête n'en envoie jamais, une seule preuve suffit |
| ApiLatencyHigh | p95 de `/api/reports` > 200ms | 5min | environ 10ms en temps normal, 200ms est 20 fois plus |
| ApiErrors | plus de 5% de réponses 5xx | 5min | 0% en temps normal, 5% = 1 requête sur 20 |

| Alerte | Faux positif | Faux négatif |
|---|---|---|
| OverlaySpikeRegression | ratio instable avec peu de trafic. En direct, le loadgen envoie 20% d'overlay et la déclenche: c'est un vrai positif, le build 26-6 a toujours la régression | si peu de joueurs ont un grand écran avec bloom, la part globale reste sous 10% |
| VaultFarming | peu probable : hors farming, aucune partie vault ne dure moins de 120s | un tricheur qui fait des parties plus longues, farme lentement ou change de carte |
| SuspiciousReports | rare: aucun client honnête n'est signalé dans l'historique | un tricheur qui reste sous 144fps. En direct, elle ne voit rien: le client falsifié n'existe que dans l'historique |
| ApiLatencyHigh | pic court avec peu de requêtes | quelques requêtes lentes ne font pas monter le p95 |
| ApiErrors | peu de trafic: 1 erreur sur 10 requêtes donne 10% | service arrêté: plus de requêtes, donc pas d'alerte |

**Aucune de ces alertes ne prévient si le service est arrêté: il faudrait en ajouter une sur `up{job="telemetry"} == 0`.**
