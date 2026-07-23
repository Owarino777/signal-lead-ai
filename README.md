# SignalLead

SignalLead recherche des entreprises locales, exclut les structures peu accessibles commercialement, découvre automatiquement leurs sites et classe les prospects selon deux dimensions distinctes :

1. capacité et accessibilité commerciale de l’entreprise ;
2. besoin réel de création ou de refonte du site.

La priorité finale n’est calculée qu’après découverte et analyse du site, ou confirmation vérifiée de son absence.

## Ciblage actuel

- fast-foods, kebabs et restauration rapide ;
- restaurants ;
- entreprises du bâtiment ;
- associations et organismes publics exclus ;
- grandes structures, ETI, groupes de plus de 50 salariés, réseaux de plus de 10 établissements et sociétés dépassant 20 M€ de chiffre d’affaires exclus du parcours standard.

## Architecture

- frontend statique : GitHub Pages ou Vercel ;
- registre d’entreprises : API Recherche d’entreprises ;
- géolocalisation : Nominatim ;
- découverte automatique : Google Places API (New), appelée uniquement depuis le backend ;
- audit : capture et métriques via Microlink pour le MVP ;
- backend : Vercel Function `api/enrich-businesses.js` ;
- persistance du MVP : stockage local versionné.

## Déploiement recommandé

Le projet complet doit être déployé sur Vercel afin que `/api/enrich-businesses` fonctionne.

1. importer le dépôt GitHub dans Vercel ;
2. activer Places API (New) dans Google Cloud ;
3. créer une clé API restreinte à Places API (New) ;
4. ajouter dans Vercel :

```text
GOOGLE_PLACES_API_KEY=<clé serveur>
ALLOWED_ORIGINS=https://owarino777.github.io,https://signal-lead-ai.vercel.app
```

5. redéployer le projet.

La clé Google ne doit jamais être placée dans `index.html`, `app.js`, `enrichment.js` ou un dépôt public.

## Sécurité du backend

- clé conservée dans les variables d’environnement Vercel ;
- liste blanche d’origines ;
- requêtes POST uniquement ;
- limite de dix entreprises par appel ;
- limitation du débit ;
- timeouts ;
- validation et limitation des entrées ;
- aucune injection HTML distante ;
- cache court pour limiter les coûts Google.

## Limites actuelles

- Google Places est facturé selon l’utilisation ;
- les correspondances entreprise/fiche Google utilisent un score de confiance et peuvent nécessiter une correction exceptionnelle ;
- l’audit Microlink est adapté à la validation du MVP, pas à un produit commercial à fort volume ;
- un backend Chromium/Lighthouse isolé devra remplacer l’audit externe pour la version commerciale.
