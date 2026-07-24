# Validation avant commercialisation

SignalLead ne doit être présenté comme un outil de prospects qualifiés que lorsque les critères ci-dessous sont validés sur des données réelles.

## 1. Fiabilité des sites officiels

Tester au minimum 100 entreprises réparties sur les quatre segments.

Objectifs :

- précision des sites acceptés : au moins 95 % ;
- aucun annuaire ou réseau social présenté comme site officiel ;
- aucun domaine sans preuve indépendante accepté pour une enseigne courte ;
- tous les résultats incertains classés « À qualifier » ;
- couverture cible avec recherche web complémentaire : au moins 60 %.

La précision est prioritaire sur la couverture. Un site non trouvé est préférable à un mauvais site.

## 2. Fiabilité des audits

Objectifs :

- au moins 80 % des sites validés analysés sans erreur ;
- aucun audit conservé lorsque l’identité du domaine est rejetée ;
- les métriques doivent être présentées comme des indicateurs commerciaux, pas comme un audit Lighthouse, RGAA ou SEO complet ;
- les preuves affichées doivent être directement reliées aux données collectées.

## 3. Utilité commerciale

Pour chaque prospect prioritaire, vérifier la présence de :

- l’entreprise et sa ville ;
- un site validé ou une absence confirmée ;
- au moins un problème concret ;
- une prestation recommandée ;
- une fourchette commerciale ;
- un message personnalisable ;
- une coordonnée publique lorsque disponible ;
- un statut de suivi.

## 4. Sécurité et stabilité

Avant chaque mise en production :

```bash
cd worker
npm test
npm run check
```

Tous les contrôles GitHub Actions doivent être verts.

Vérifier également :

- aucune clé dans Git ou dans le frontend ;
- `ALLOWED_ORIGINS` limité aux domaines du produit ;
- limitation du débit active ;
- protection SSRF active ;
- sauvegarde et restauration testées ;
- webhook Stripe testé en mode test ;
- achat, renouvellement et annulation testés.

## 5. Activation commerciale

Le mode test reste actif avec :

```json
"SAAS_MODE": "false"
```

La mise en vente nécessite :

1. création de la base Cloudflare D1 ;
2. application des migrations ;
3. création des prix Stripe ;
4. ajout des secrets Stripe ;
5. configuration du webhook ;
6. passage de `SAAS_MODE` à `true` ;
7. test complet avec une carte Stripe de test ;
8. ajout des mentions légales, CGV et politique de confidentialité définitives.

## Décision de lancement

Le produit peut être ouvert à des bêta-testeurs avant d’atteindre tous les objectifs.

La publicité payante et la promesse « prospects automatiquement qualifiés » ne doivent commencer qu’après validation des critères de précision et du parcours de paiement.
