# BLOOM v5.1 - Audit Scoring
## 19/03/2026

---

## SAFETY SCORE (0-100)

### Points positifs (max ~110, cap 100)

| Critere           | Max | Condition                        |
|-------------------|-----|----------------------------------|
| Liquidite         | 20  | >= $100K                         |
| Vol/Liq ratio     | 12  | entre 0.5x et 50x               |
| Age               | 12  | > 48h                            |
| Buy ratio 24h     | 12  | > 65%                            |
| Buy ratio 1h      | 8   | > 60%                            |
| Market cap        | 8   | >= $100K                         |
| Mint disabled     | 10  | rugcheck                         |
| Freeze disabled   | 8   | rugcheck                         |
| LP burned/locked  | 10  | rugcheck                         |
| Social            | 5   | score >= 60                      |
| Holders           | 5   | >= 500 holders                   |

### Penalties

| Condition                    | Malus |
|------------------------------|-------|
| Vol/Liq > 100x              | -20   |
| Vol/Liq > 50x               | -12   |
| Buy ratio 1h < 30% (>20tx)  | -8    |
| Dump 24h < -50%             | -15   |
| Dump 24h < -30%             | -8    |
| Dump 1h < -30%              | -10   |
| Age < 30 min                | -5    |
| Holders < 20 (age > 1h)     | -3    |
| LP unlocked                 | -10   |
| Mint enabled                | -8    |
| Buy slippage > 15%          | -10   |
| Buy slippage > 10%          | -5    |
| Sell slippage > 20%         | -12   |
| Sell slippage > 10%         | -6    |
| Sell tax > 30%              | -30   |
| Sell tax > 15%              | -20   |
| Sell tax > 8%               | -8    |
| Honeypot                    | -40   |

### Seuil Safe: DYNAMIQUE
80eme percentile des scores safety, clamp 50-85.
Affiche dans la stat bar: "Safe (>XX)".
S'adapte au marche: si 80% des tokens sont < 40 safety, le seuil descend.

---

## RETURN PROBA (0-100 raw -> 5-85% affiche)

### Points

| Critere              | Max | Condition                  |
|----------------------|-----|----------------------------|
| Vol/MCap             | 20  | > 5x                      |
| Buy pressure 24h     | 15  | > 75%                      |
| Buy pressure 1h      | 15  | > 75%                      |
| MCap room            | 15  | < $50K                     |
| Momentum 1h          | 15  | +10% a +50% (sweet spot)   |
| Momentum 5m          | 10  | +20% a +200%               |
| Liq/MCap             | 10  | 0.1 a 0.5                  |

### Penalties return

| Condition               | Malus |
|-------------------------|-------|
| 24h < -50%             | -30   |
| 24h < -30%             | -15   |
| 1h < -20%              | -20   |
| Vol/Liq > 100x         | -15   |
| Staircase              | -30   |
| LP unlocked            | -10   |
| Sell tax > 15%         | -40   |
| Sell tax > 8%          | -12   |
| MCap > $10M            | -10   |
| MCap > $5M             | -5    |
| Honeypot               | = 0   |

### Boosters

| Signal              | Bonus |
|---------------------|-------|
| Trend match         | +10   |
| Early pump >= 70    | +15   |
| Early pump >= 40    | +8    |
| Smart money >= 60   | +12   |
| Smart money >= 30   | +5    |

### Sigmoid: steepness 0.12
| Raw  | Proba |
|------|-------|
| 20   | 8%    |
| 40   | 26%   |
| 50   | 45%   |
| 60   | 66%   |
| 80   | 83%   |

### Horizon: DYNAMIQUE
Calcule sur volatilite (|change_1h| + |change_5m| * 3) + age + volume pace (vol_1h / mcap).
Sorties possibles: 30min-1h, 1-2h, 2-4h, 4-6h, 6-12h, 12-24h, 1-2j, 2-5j.

### expectedGain (conservateur)
| MCap       | Gain max |
|------------|----------|
| < $30K     | +300%    |
| < $100K    | +150%    |
| < $500K    | +80%     |
| < $2M      | +40%     |
| >= $2M     | +15%     |
Reduit par: dump 24h (*0.3), sell tax >8% (*0.5), staircase (*0.2)

---

## SMART MONEY - SYSTEME DE REPUTATION

### Comment ca marche
Chaque wallet est suivi avec: wins, losses, reputation, rugsAssociated.
- Token gagnant (+50% en 24h): buyers recoivent +1 reputation, +1 win
- Token rug (honeypot, safety < 15, -80% 24h, staircase): buyers recoivent -2 reputation, +1 loss, +1 rugAssociated
- La penalite rug est 2x le bonus win (asymetrique, volontaire)

### Labels
| Label              | Condition                        |
|--------------------|----------------------------------|
| early_buyer        | rep >= 0, par defaut             |
| consistent_winner  | rep >= 3, wins >= 3              |
| whale_sniper       | rep >= 5, wins >= 5              |
| rug_associated     | rugsAssociated >= 3              |
| dump_wallet        | rep < -3                         |

### Scoring smart money
| Signal                           | Points |
|----------------------------------|--------|
| 3+ wallets confirmes (rep >= 0)  | +35    |
| 2 wallets confirmes              | +25    |
| 1 wallet confirme                | +15    |
| Win rate >= 70%                  | +15    |
| Win rate >= 50%                  | +8     |
| Win rate faible                  | -5     |
| 15+ buyers uniques               | +15    |
| 8+ buyers uniques                | +10    |
| 5+ buys en 5 min                | +10    |
| 2+ wallets toxiques              | -30    |
| 1 wallet toxique                 | -15    |
| Top 3 buyers > 80% du volume    | -10    |

### Trust levels
- unknown: pas de data
- neutral: quelques wallets, pas de signal fort
- moderate: 1+ wallet confirme
- high: 3+ wallets confirmes, bonne rep
- suspect: wallets toxiques detectes

---

## BACKTESTING

### Fonctionnement
- Chaque token avec safety >= 40 ou early_pump >= 40 est logge au scan
- Donnees loggees: safety, potential, probability, price, mcap, earlyPump, smartMoney, aiVerdict
- Toutes les 10 min, le systeme compare le prix actuel avec le prix logge
- Si 4h passees: result_4h = win (+10%), loss (-20%), ou flat
- Si 24h passees: result_24h = win (+20%), loss (-30%), ou flat
- Max 500 entrees en memoire

### API
GET /api/backtest retourne:
- Win rates 4h et 24h
- 20 derniers resultats avec prix d'entree et prix actuel

### Usage
Compare le win rate avec les probabilites affichees.
Si BLOOM dit 60% et le win rate reel est 30%, les poids sont trop genereux.

---

## CHECKLIST COMPLETE v5.1

| # | Feature                           | Status |
|---|-----------------------------------|--------|
| 1 | Rugcheck bonus gratuit supprime   | OK     |
| 2 | Penalite age < 30 min             | OK     |
| 3 | Sell tax seuil 8% (safety)        | OK     |
| 4 | Sell tax seuil 8% (return)        | OK     |
| 5 | Sell tax seuil 8% (gain)          | OK     |
| 6 | Momentum 1h recalibre             | OK     |
| 7 | expectedGain conservateur          | OK     |
| 8 | Sigmoid 0.12                      | OK     |
| 9 | Holders dans safety (+5/+3/-3)    | OK     |
| 10| MCap ceiling (-5/-10 return)      | OK     |
| 11| Horizon dynamique                 | OK     |
| 12| Backtesting logger + API          | OK     |
| 13| Seuil Safe dynamique (P80)        | OK     |
| 14| Smart money reputation system     | OK     |
| 15| Wallets toxiques detection        | OK     |
| 16| Trust levels (suspect/high/etc)   | OK     |
| 17| Analyse IA manuelle (bouton)      | OK     |
| 18| Analyse IA enrichie (SL/TP/etc)   | OK     |
