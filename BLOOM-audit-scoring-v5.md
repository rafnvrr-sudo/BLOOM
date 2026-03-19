# BLOOM v5 - Audit Complet du Scoring
## 19/03/2026

---

## 1. SAFETY SCORE (0-100)

### Decomposition des points (max theorique)

| Critere           | Points max | Condition max                    |
|-------------------|-----------|----------------------------------|
| Liquidite         | 20        | >= $100K                         |
| Vol/Liq ratio     | 12        | entre 0.5x et 50x               |
| Age               | 12        | > 48h                            |
| Buy ratio 24h     | 12        | > 65%                            |
| Buy ratio 1h      | 8         | > 60%                            |
| Market cap        | 8         | >= $100K                         |
| Mint disabled     | 10        | rugcheck: mint off               |
| Freeze disabled   | 8         | rugcheck: freeze off             |
| LP burned/locked  | 10        | rugcheck: LP secured             |
| Social            | 5         | score social >= 60               |
| **TOTAL MAX**     | **105**   | (cap a 100)                      |

### Penalties actives

| Condition                    | Malus  |
|------------------------------|--------|
| Vol/Liq > 100x              | -20    |
| Vol/Liq > 50x               | -12    |
| Buy ratio 1h < 30% (>20tx)  | -8     |
| Dump 24h < -50%             | -15    |
| Dump 24h < -30%             | -8     |
| Dump 1h < -30%              | -10    |
| Age < 30 min                | -5     |
| LP unlocked                 | -10    |
| Mint enabled                | -8     |
| Buy slippage > 15%          | -10    |
| Buy slippage > 10%          | -5     |
| Sell slippage > 20%         | -12    |
| Sell slippage > 10%         | -6     |
| Sell tax > 30%              | -30    |
| Sell tax > 15%              | -20    |
| Sell tax > 8%               | -8     |
| Honeypot                    | -40    |

### Corrections appliquees (v4 -> v5)

**FIX 1: Bonus gratuit rugcheck supprime**
- AVANT: token sans rugcheck recevait +10 pts ("pending scan")
- APRES: 0 pts. Le token doit prouver sa securite, pas l'inverse.
- IMPACT: tokens non verifies perdent ~10 pts de safety. Plus realiste.

**FIX 2: Penalite tokens tres jeunes**
- AVANT: aucune penalite specifique pour age < 30 min
- APRES: -5 pts si age < 30 min
- RAISON: les tokens de moins de 30 min sont les plus risques (rug dans les premieres minutes)

**FIX 3: Seuil sell tax ajuste**
- AVANT: sell tax > 5% = -10 pts (trop agressif)
- APRES: sell tax > 8% = -8 pts
- RAISON: 2-5% de slippage est normal sur memecoins low liq Solana. Penaliser a 5% disqualifie des tokens legitimes.

### Problemes restants a surveiller

1. **Seuil "Safe" a 75**: pour un token < 6h d'age, atteindre 75 requiert rugcheck clean + liq > $20K + bon buy ratio + mcap > $50K. Ca exclut les early plays legits. A tester si 65-70 serait un meilleur seuil pour la tab "Safe".

2. **Score social cap a 5 pts**: le social pese peu dans le safety total (5/100). C'est voulu (un bon Twitter ne protege pas d'un rug). Mais si tu veux valoriser plus la presence sociale, tu peux monter a 8-10 pts.

3. **Pas de score pour le nombre de holders**: DEX Screener retourne parfois 0 holders. Quand la donnee est dispo, un token avec 500+ holders est plus safe qu'un token avec 20 holders. A ajouter dans une prochaine version.

---

## 2. RETURN PROBA (0-100 raw, converti en 5-85% probabilite)

### Decomposition des points

| Critere              | Points max | Condition max                       |
|----------------------|-----------|-------------------------------------|
| Vol/MCap ratio       | 20        | > 5x                               |
| Buy pressure 24h     | 15        | > 75%                               |
| Buy pressure 1h      | 15        | > 75%                               |
| MCap room            | 15        | < $50K                              |
| Momentum 1h          | 15        | +10% a +50% (sweet spot)            |
| Momentum 5m          | 10        | +20% a +200%                        |
| Liq/MCap ratio       | 10        | entre 0.1 et 0.5                    |
| **TOTAL BASE MAX**   | **100**   |                                     |

### Boosters

| Signal           | Bonus   | Condition           |
|------------------|---------|---------------------|
| Trend match      | +10     | trend actif         |
| Early pump >= 70 | +15     | signaux pump forts  |
| Early pump >= 40 | +8      | signaux pump moyens |
| Smart money >= 60| +12     | wallets confirmes   |
| Smart money >= 30| +5      | wallets detectes    |

### Penalties return proba

| Condition               | Malus   |
|-------------------------|---------|
| 24h < -50%             | -30     |
| 24h < -30%             | -15     |
| 1h < -20%              | -20     |
| Vol/Liq > 100x         | -15     |
| Staircase              | -30     |
| LP unlocked            | -10     |
| Sell tax > 15%         | -40     |
| Sell tax > 8%          | -12     |
| Honeypot               | = 0     |

### Conversion raw -> probabilite

Formule: `probability = 5 + sigmoid(rawScore) * 80`
Sigmoid: `1 / (1 + exp(-0.12 * (x - 50)))` (steepness 0.12)

| Raw Score | Probabilite affichee |
|-----------|---------------------|
| 0         | 5%                  |
| 20        | 8%                  |
| 30        | 14%                 |
| 40        | 26%                 |
| 45        | 34%                 |
| 50        | 45%                 |
| 55        | 56%                 |
| 60        | 66%                 |
| 70        | 78%                 |
| 80        | 83%                 |
| 100       | 85%                 |

### Corrections appliquees (v4 -> v5)

**FIX 1: Momentum 1h recalibre**
- AVANT: +100% a +1000% donnait max pts (+15). Un token a +500% en 1h etait note pareil qu'un token a +30%.
- APRES: +10% a +50% = 15 pts (sweet spot pre-pump). +50% a +150% = 10 pts. +150% = 3 pts (post-pump).
- RAISON: un token qui a fait +200% en 1h est plus proche du sommet que du debut. Le vrai signal c'est +10-50% avec volume croissant.

**FIX 2: expectedGain conservateur**
- AVANT: MCap < $30K = +500% estime
- APRES: MCap < $30K = +300% estime
- Toute la grille ajustee vers le bas de ~30-40%.

**FIX 3: Sigmoid plus raide**
- AVANT: steepness 0.08 (trop plat au milieu, tokens 40-60 raw tous entre 38-52%)
- APRES: steepness 0.12 (raw 40 = 26%, raw 60 = 66%. Meilleure separation)

**FIX 4: Sell tax aligne a 8%**
- AVANT: sell tax > 5% = -15 dans return proba
- APRES: sell tax > 8% = -12
- Coherence avec le fix safety.

### Problemes restants a surveiller

1. **Buy pressure 24h et 1h utilisent les memes criteres dans safety ET return proba**: un token avec 80% buy ratio recoit un double boost. C'est voulu (buy pressure est a la fois un signal de securite et de potentiel) mais ca cree une correlation forte entre les deux scores.

2. **Pas de penalite pour mcap deja eleve**: un token a $5M mcap recoit 0 pts de "MCap room" mais aucune penalite. Un token a $10M+ devrait avoir un malus car le potentiel de x2 est faible.

3. **Horizon fixe par age, pas par volatilite**: un token de 2h avec 0% de volatilite a le meme horizon "4h" qu'un token de 2h a +200%. L'horizon devrait aussi prendre en compte la vitesse du mouvement.

---

## 3. EARLY PUMP SCORE (0-100)

### Signaux

| Signal                      | Points | Condition                       |
|-----------------------------|--------|---------------------------------|
| Volume 1h > 2x MCap        | 25     | age < 4h                       |
| Volume 1h > MCap           | 18     | age < 4h                       |
| Volume 1h > 50% MCap       | 10     | age < 4h                       |
| Momentum 5m > 15%          | 20     | age < 6h, < 300%               |
| Momentum 5m > 30%          | 12     | tout age, < 500%               |
| Buy pressure 1h > 80%      | 20     | > 10 txns                      |
| Buy pressure 1h > 70%      | 12     | > 10 txns                      |
| Liq >= $30K (jeune)        | 10     | age < 4h                       |
| Liq >= $50K                | 8      | age < 12h                      |
| Holder velocity > 500/h    | 15     | entre deux scans                |
| Holder velocity > 100/h    | 10     | entre deux scans                |
| Volume acceleration > 5x   | 15     | vol 1h vs moy 6h               |
| Volume acceleration > 3x   | 10     | vol 1h vs moy 6h               |
| DEX Screener Boost actif   | 10     | token dans boosts               |

### Etat actuel: OK, pas de fix necessaire.

---

## 4. SMART MONEY SCORE (0-100)

Depend de HELIUS_API_KEY. Sans Helius, ce score reste a 0 pour tous les tokens.

### Scoring

| Signal                     | Points |
|----------------------------|--------|
| 3+ smart wallets           | 40     |
| 2 smart wallets            | 30     |
| 1 smart wallet             | 20     |
| Total PNL > $100K          | 25     |
| Total PNL > $10K           | 15     |
| 15+ unique buyers recents  | 15     |
| 8+ unique buyers           | 10     |
| 5+ buys dans 5 min         | 10     |

### Limite connue

La base de "known wallets" se construit au fil du temps. Au premier deploy, elle est vide. Il faut ~24h de scans pour commencer a avoir des wallets recurrents. Tu peux aussi ajouter manuellement des wallets via `POST /api/wallets`.

---

## 5. SOCIAL SCORE (0-100)

| Signal           | Points |
|------------------|--------|
| Twitter/X        | 30     |
| Website          | 25     |
| Telegram         | 15     |
| Discord          | 10     |
| Multi-plateforme | +20 (3+) ou +10 (2) |

### Etat actuel: OK. Le social pese 5 pts max dans le safety, ce qui est delibere.

---

## 6. CHECKLIST DES CORRECTIONS v5

| # | Fix                                  | Fichier     | Ligne approx | Status |
|---|--------------------------------------|-------------|-------------|--------|
| 1 | Supprime +10 pts rugcheck manquant   | server.js   | 155         | OK     |
| 2 | Penalite age < 30 min (-5)           | server.js   | 140-144     | OK     |
| 3 | Sell tax seuil 5% -> 8% (safety)     | server.js   | 167-168     | OK     |
| 4 | Sell tax seuil 5% -> 8% (return)     | server.js   | 223-224     | OK     |
| 5 | Sell tax seuil 5% -> 8% (gain)       | server.js   | 250         | OK     |
| 6 | Momentum 1h recalibre (return)       | server.js   | 206-210     | OK     |
| 7 | expectedGain conservateur            | server.js   | 242-247     | OK     |
| 8 | Sigmoid 0.08 -> 0.12                 | server.js   | 239         | OK     |
| 9 | Analyse IA manuelle (endpoint)       | server.js   | ~1155       | OK     |
| 10| Analyse IA enrichie (prompt)         | server.js   | ~703-770    | OK     |
| 11| Bouton analyser (frontend)           | App.jsx     | TokenDetail | OK     |
| 12| Affichage IA complet (frontend)      | App.jsx     | TokenDetail | OK     |

---

## 7. PROCHAINES AMELIORATIONS POSSIBLES

1. **Holders dans le safety score**: ajouter +5 pts si holders > 500, +3 si > 100. Necessite que DEX Screener retourne la donnee.

2. **MCap ceiling penalty (return)**: -5 pts si mcap > $5M, -10 si > $10M. Le potentiel de x2 diminue avec la taille.

3. **Horizon dynamique**: calculer l'horizon basé sur volatilite + age + volume, pas seulement l'age.

4. **Backtesting**: logger les scores au moment du scan et comparer avec le prix 4h/24h plus tard. Ca permettrait de calibrer les poids avec des donnees reelles.

5. **Seuil "Safe" dynamique**: au lieu de 75 fixe, utiliser le 80eme percentile du safety score sur les 200 tokens scannés. Ca s'adapte aux conditions du marche.
