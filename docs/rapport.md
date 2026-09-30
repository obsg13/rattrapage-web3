## B3 - Rapport de qualité des données

Source : `data/admin-export-2026-09-20_26.log`, ingéré dans Loki par `scripts/ingest-history.js`
sous les labels `{job="telemetry-historique", event="game_completed"|"perf_spike"}`.
Chaque ligne Loki est un JSON: `headerId`, `summary`, `occurrence`, `orphan` (spikes), `report{...}` et `server{...}`.
`| json` aplatit les champs imbriqués avec `_` : `report.work.totalMs` devient `report_work_totalMs`.

Toutes les requêtes sont des requêtes **instantanées** évaluées au `2026-09-27T00:00:00.001Z`, avec une fenêtre `[8d]` qui couvre tout l'export (voir B3.8 pour les millisecondes).

### B3.1 - Volumétrie et période couverte

| Type | Lignes dans Loki | Doublons | Événements uniques |
|---|---|---|---|
| game_completed | 796 | 17 | **779** |
| perf_spike | 2148 | 38 | **2110** |
| **Total** | **2944** | **55** | **2889** |

```logql
sum by (event) (count_over_time({job="telemetry-historique"}[8d]))
sum by (event) (count_over_time({job="telemetry-historique"} | json | occurrence = 1 [8d]))
```

Période couverte: du **19/09/2026 22:31:37 UTC** au **26/09/2026 22:04:13 UTC**, soit 7 jours.
Preuve : `{job="telemetry-historique"}` dans Grafana Explore, en tri « Oldest first » puis « Newest first ».

**Impact :** le nom du fichier (« 20_26 ») ne correspond pas aux dates UTC. Le premier événement date du 19/09 au soir en UTC (20/09 00:31 à Paris). Toutes les analyses doivent compter sur `occurrence = 1`, sinon elles surestiment de 1,9%.

### B3.2 - Pièges de format et traitement par le script

| Piège | Exemple | Traitement dans `ingest-history.js` |
|---|---|---|
| Texte multi-lignes | en-tête `Game completed Ju73lcJQS · 9/27/2026, 12:04:13 AM`, puis résumé `harbor · 1 - 3`, puis JSON indenté sur plusieurs lignes | le fichier est coupé en blocs sur les lignes vides (`split('\n\n')`). Ligne 0 = en-tête (type + `headerId` + date), ligne 1 = `summary`, le reste = JSON. Chaque bloc devient **une seule** ligne JSON compacte (`JSON.stringify`). Un JSON illisible serait gardé avec `jsonCasse: true` (0 cas dans l'export). |
| Date US 12 h AM/PM, heure de Paris | `9/27/2026, 12:04:13 AM` = 26/09 22:04:13 UTC | `parseDate` inverse mois/jour, convertit 12 AM en 0 h et ajoute 12 h aux heures PM, puis ajoute le suffixe `+02:00` (heure d'été). Loki reçoit donc un timestamp UTC. Limite : `+02:00` est codé en dur, ce qui est valable jusqu'au 25/10. |
| Ordre antichronologique | le fichier commence par l'événement le plus récent | `events.sort((a, b) => a.ts - b.ts)` avant l'envoi, car Loki attend des lignes dans l'ordre croissant pour chaque flux. |

**Impact :** sans ces conversions, les courbes seraient décalées de 2 h (voire de 12 h pour les heures entre minuit et 1 h du matin), et Loki refuserait une partie des lignes.

### B3.3 - Doublons exacts

**55 blocs** apparaissent au moins deux fois à l'identique: 17 `game_completed` et 38 `perf_spike`.
Le script numérote chaque copie dans `occurrence`. Sans cela, Loki fusionnerait en silence les lignes identiques qui ont le même timestamp, et on ne pourrait plus mesurer les doublons.

```logql
sum by (event) (count_over_time({job="telemetry-historique"} | json | occurrence > 1 [8d]))
```

**Impact :** on ajoute `| json | occurrence = 1` à toutes les requêtes d'analyse, sinon les taux de spikes et le nombre de parties sont gonflés.

### B3.4 - Changement de schéma v1 → v2

| Version | Build | `rttMs` | `work.stages.physics` | Rapports uniques |
|---|---|---|---|---|
| 1 | tous les builds avant 26/09-6 | `report.rttMs` (racine) | absent | 2085 |
| 2 | `beta-20260926-6` | `report.network.rttMs` | présent | **25** |

```logql
sum by (report_version, report_build) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | report_version = 2 [8d]))
sum by (report_version) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | report_rttMs != "" [8d]))
sum by (report_version) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | report_network_rttMs != "" [8d]))
sum by (report_version) (count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | report_work_stages_physics != "" [8d]))
```

**Impact :** une courbe de latence construite uniquement sur `report_rttMs` s'arrête net au build 26-6, ce qui pourrait passer pour une panne alors qu'il n'y en a pas. Il faut lire les deux champs selon `report_version`. De même, `stages.physics` n'est comparable qu'entre rapports v2 : les 25 rapports sont trop peu nombreux pour conclure.

### B3.5 - Spikes orphelins

**74 spikes uniques** (75 lignes avec un doublon) ont `orphan = true`. Cela veut dire qu'aucun `Game completed` de l'export ne correspond à leur `server.id`.

```logql
sum(count_over_time({job="telemetry-historique", event="perf_spike"} | json | occurrence = 1 | orphan = "true" [8d]))
```

Ces parties ne sont pas situées au début ni à la fin de l'export : leur absence ne vient donc pas de la coupure du fichier.
- 4 spikes (2 parties) se produisent juste avant le trou du 22/09 à 11:59 UTC (voir B3.6).
- Les 70 autres (70 parties) apparaissent à partir du 24/09 à 07:32 UTC. Ce sont des parties sans fin enregistrée : abandons ou crashs.

**Impact :** le script ne peut pas rattacher ces spikes à une carte finale ni à un score. On les garde pour mesurer les performances, mais on les exclut des analyses « par partie terminée ». Leur apparition le 24/09 mérite d'être croisée avec les builds (partie E/F).

### B3.6 - Trous dans les données

Requête en mode **Range** dans Grafana (pas d'1 h, du 19/09 au 27/09) :

```logql
sum(count_over_time({job="telemetry-historique"} | json | occurrence = 1 [1h]))
```

- **Nuits calmes (normal) :** 10 silences de 60 à 84 min, tous entre 23 h et 05 h UTC (01 h à 07 h à Paris). À ces heures, l'activité tombe à environ 3 événements par heure. Ces silences sont à cheval sur deux fenêtres : aucune fenêtre d'1 h n'est vide, elles sont simplement basses.
- **Trou anormal : le 22/09 de 11:59 à 14:14 UTC** (13:59 à 16:14 à Paris), soit 135 min. Ce sont les **deux seules fenêtres d'1 h à 0** de toute la période (fin 13:00 et fin 14:00). Cette tranche compte d'habitude environ 16 événements par heure, il en manque donc à peu près 35.

**Impact :** l'absence de spikes pendant ce trou ne prouve pas que le jeu allait bien. C'est une panne probable du serveur ou de la collecte. On exclut cette tranche des calculs de taux, et on signale les 2 parties orphelines interrompues juste avant.

### B3.7 - Incohérences: rapports falsifiés

Deux règles physiquement impossibles :
- `fps > 144`, alors que le jeu plafonne à 144;
- `frameMs < work.totalMs`, c'est-à-dire une image plus courte que le travail qu'elle contient.

LogQL ne sait pas comparer deux champs entre eux. On calcule donc la différence avec `label_format` et `subf`, puis on filtre sur `ecart > 0`. L'id client est extrait de `report.id` (format `P-<client>-<seq>`) avec `regexp`.

```logql
sum by (client) (count_over_time({job="telemetry-historique", event="perf_spike"}
  | json | occurrence = 1
  | label_format ecart=`{{ subf .report_work_totalMs .report_frameMs }}`
  | report_fps > 144 or ecart > 0
  | regexp `"id":"P-(?P<client>[0-9a-f]+)-` [8d]))
```

Résultat: **70 rapports incohérents, tous du client `5e1f0c7a`** (sur 231 clients). Chaque règle prise seule trouve les mêmes 70 rapports. Ce sont aussi **tous** les rapports de ce client.

**Impact:** ces 70 rapports faussent les moyennes de FPS et de temps de frame. On les exclut de l'analyse de performance, par exemple avec `!= "P-5e1f0c7a-"`, et on les traite comme un cas de sécurité (client modifié ou rapports forgés).

### B3.8 - Piège de mesure dans Loki

En comptant les lignes, j'ai obtenu **2943 au lieu de 2944**, et le résultat changeait selon l'heure où j'évaluais la requête :

| Instant d'évaluation | Lignes comptées |
|---|---|
| `2026-09-27T00:00:00Z` | 2943 |
| `2026-09-30T12:34:56Z` | 2942 |
| `2026-09-27T00:00:00.001Z` | **2944** |

```logql
sum(count_over_time({job="telemetry-historique"}[20d]))
```

En comptant heure par heure, j'ai trouvé la ligne manquante : `P-393390d2-18`, horodatée **pile à 22:00:00.000 UTC**.

```logql
{job="telemetry-historique", event="perf_spike"} |= `"id":"P-393390d2-18"`
```

La configuration de Loki (`/config`) contient `split_instant_metric_queries_by_interval: 1h` : Loki découpe les requêtes instantanées en tranches d'1 h, et une ligne qui tombe exactement sur une frontière de tranche peut être oubliée.
Comme nos timestamps sont tous à la seconde, décaler l'instant d'évaluation d'1 ms (`...00.001Z`) évite toute frontière.

**Impact:** un écart de 1 ou 2 lignes vient de l'outil, pas des données. Toutes les requêtes de ce rapport sont donc évaluées à `2026-09-27T00:00:00.001Z`.

### Choix des labels et cardinalité

Loki indexe **uniquement les labels**, et chaque combinaison de labels crée un flux séparé. Un label doit donc avoir peu de valeurs possibles.
- `job` (2 valeurs : `telemetry`, `telemetry-historique`), `level` (`info`, `warn`) et `event` (5 types) restent sous la dizaine de valeurs. Ce sont les premiers filtres de toutes les requêtes, d'où leur place en labels.
- `report.id` (un par rapport, environ 2100), `client` (231), `server.id` (752 parties rien que dans les spikes) et `build` (une nouvelle valeur à chaque déploiement) créeraient des centaines ou milliers de petits flux. L'index grossirait et les requêtes ralentiraient.

Ces champs restent donc dans le contenu JSON, et on les filtre au moment de la requête avec `| json` (ou `|=` pour un filtre texte rapide).
