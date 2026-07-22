# SignalLead AI — MVP public

SignalLead AI recherche des entreprises locales, analyse leurs sites avec Lighthouse, calcule un score d'opportunité explicable et prépare un message de prise de contact fondé sur les faits détectés.

## Fonctionnalités

- recherche géographique via OpenStreetMap ;
- saisie manuelle d'URLs ;
- analyse PageSpeed Insights mobile ;
- scoring déterministe avec niveau de confiance ;
- preuves et signaux lisibles ;
- génération de message contrôlée ;
- Prompt API locale de Chrome/Edge lorsque disponible ;
- statuts prospect ;
- export CSV et impression PDF ;
- stockage local versionné ;
- interface responsive et accessible.

## Lancer localement

```bash
npm run dev
```

Puis ouvrir `http://localhost:4173`.

## Vérifications

```bash
npm run check
npm test
```

## Limites du MVP

Le service public Nominatim impose un maximum absolu d'une requête par seconde et demande une attribution. PageSpeed fonctionne sans clé pour de faibles volumes mais une clé est recommandée pour des appels fréquents. La version commerciale devra donc utiliser un backend, des quotas, une file de jobs et des fournisseurs adaptés.

Aucun email n'est envoyé automatiquement. Les informations publiques doivent être vérifiées avant toute prise de contact.

## Architecture

Voir [`docs/ADR-001-mvp-architecture.md`](./docs/ADR-001-mvp-architecture.md).
