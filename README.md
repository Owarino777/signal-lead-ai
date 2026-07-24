# SignalLead

SignalLead recherche des entreprises locales, vérifie leur site officiel, analyse leur besoin numérique et transforme les résultats en actions commerciales simples.

## Ce que le produit fait

1. trouve des entreprises actives autour d’une zone ;
2. exclut les associations, organismes publics, grandes chaînes et structures trop importantes ;
3. rapproche chaque entreprise d’un établissement OpenStreetMap ;
4. cherche et valide le site officiel avec plusieurs preuves ;
5. rejette automatiquement les domaines qui ne correspondent pas à l’entreprise ;
6. analyse le site, ses technologies, son mobile, son SEO, sa structure et sa conversion ;
7. classe le prospect : à contacter, à proposer, à qualifier, peu prioritaire ou à écarter ;
8. fournit une prestation recommandée, un budget indicatif, un message et des coordonnées publiques actionnables.

## Ciblage actuel

- fast-foods, kebabs et restauration rapide ;
- restaurants traditionnels ;
- entreprises du bâtiment ;
- associations et organismes publics exclus ;
- chaînes connues et grandes structures exclues ;
- entreprises de plus de 50 salariés, de plus de 10 établissements ou dépassant 20 M€ de chiffre d’affaires exclues du parcours standard.

## Architecture

```text
GitHub Pages
├── interface de recherche
├── classement commercial
├── fiches prospect
├── export CSV
└── module SaaS optionnel

Cloudflare Worker
├── recherche OpenStreetMap / Overpass
├── découverte hybride des sites
├── validation d’identité du domaine
├── audit HTML sécurisé
├── comptes et sessions optionnels
├── sauvegarde Cloud D1 optionnelle
├── quotas optionnels
└── Stripe optionnel
```

### Sources et stratégies

- entreprises : API Recherche d’entreprises de l’État ;
- géocodage : Nominatim ;
- établissements et sites déclarés : OpenStreetMap / Overpass ;
- recherche web complémentaire : Brave Search API, uniquement lorsqu’une clé serveur est configurée ;
- dernier recours : domaines probables, systématiquement validés avant acceptation ;
- audit : backend Cloudflare avec protection SSRF, limites de taille, délais et contrôle des redirections.

## Mode actuel

Le dépôt est configuré avec :

```json
"SAAS_MODE": "false"
```

Les comptes, quotas et paiements restent donc désactivés afin de ne pas bloquer les tests fonctionnels.

## Vérifications locales

Depuis `worker/` :

```bash
npm install
npm test
npm run check
```

Le workflow GitHub `Quality checks` vérifie également :

- la syntaxe des scripts du frontend ;
- l’absence de double chargement des modules ;
- les tests du moteur de correspondance ;
- la compilation Cloudflare Worker avec `wrangler deploy --dry-run`.

## Déploiement du Worker de test

Depuis `worker/` :

```bash
npm install
npm run deploy
```

Le frontend continue de fonctionner sans compte tant que `SAAS_MODE` vaut `false`.

## Activer la version commerciale

### 1. Créer la base D1

```bash
cd worker
npx wrangler d1 create signal-lead-db
```

Copier l’identifiant retourné dans une copie de `wrangler.saas.example.jsonc`, puis utiliser cette configuration comme `wrangler.jsonc`.

### 2. Appliquer la migration

```bash
npx wrangler d1 migrations apply signal-lead-db --remote
```

La migration crée :

- les utilisateurs ;
- les sessions sécurisées ;
- les abonnements ;
- les compteurs d’utilisation ;
- la sauvegarde des prospects.

### 3. Créer les offres Stripe

Créer deux prix mensuels dans Stripe :

- Solo : 29 € par mois ;
- Pro : 79 € par mois.

Renseigner leurs identifiants dans :

```json
"STRIPE_PRICE_SOLO": "price_...",
"STRIPE_PRICE_PRO": "price_..."
```

### 4. Ajouter les secrets Cloudflare

```bash
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Optionnel, pour augmenter la couverture de découverte des sites :

```bash
npx wrangler secret put BRAVE_SEARCH_API_KEY
```

Aucune clé ne doit être placée dans le frontend ou commise dans Git.

### 5. Configurer le webhook Stripe

Endpoint :

```text
https://signal-lead-api.malikcheikhpro14.workers.dev/api/stripe/webhook
```

Événements nécessaires :

```text
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
```

### 6. Activer le mode SaaS

Dans `worker/wrangler.jsonc` :

```json
"SAAS_MODE": "true",
"APP_URL": "https://owarino777.github.io/signal-lead-ai"
```

Puis déployer :

```bash
npm run deploy
```

L’interface affiche alors automatiquement :

- création de compte et connexion ;
- synchronisation des prospects ;
- quotas mensuels ;
- offres et paiement Stripe ;
- état de l’abonnement.

## Offres configurées

| Offre | Prix | Recherches / mois | Prospects / recherche | Audits / mois |
|---|---:|---:|---:|---:|
| Découverte | Gratuit | 5 | 10 | 20 |
| Solo | 29 € | 100 | 50 | 600 |
| Pro | 79 € | 500 | 50 | 3 000 |

## Sécurité

- aucune clé privée dans le frontend ;
- origines autorisées explicitement ;
- endpoints sensibles en POST ou avec authentification ;
- sessions aléatoires stockées uniquement sous forme de hash ;
- mots de passe dérivés avec PBKDF2 SHA-256 et sel aléatoire ;
- validation Stripe par signature HMAC ;
- protection SSRF sur les audits ;
- blocage des IP privées, ports non autorisés et redirections dangereuses ;
- limites de taille, délais et débit ;
- domaines d’annuaires, réseaux sociaux et pages stationnées exclus ;
- verdict commercial impossible tant que le site n’est pas suffisamment vérifié.

## Limites honnêtes

- aucune source gratuite ne garantit de retrouver 100 % des sites officiels ;
- un résultat non confirmé reste classé « à qualifier » et ne doit pas être vendu comme certain ;
- le score technique est un indicateur commercial, pas un audit Lighthouse, RGAA ou SEO complet ;
- la version commerciale doit être testée avec de vrais utilisateurs avant une campagne publicitaire importante.
