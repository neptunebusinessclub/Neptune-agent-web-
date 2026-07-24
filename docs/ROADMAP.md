# Roadmap de livraison

## Lot 0 — Fondation livrée dans cette branche

- [x] monorepo TypeScript ;
- [x] protocole d’actions fermé ;
- [x] extension Manifest V3 ;
- [x] side panel Neptune ;
- [x] exécuteur navigateur générique ;
- [x] validation humaine ;
- [x] Worker Cloudflare ;
- [x] D1 ;
- [x] Durable Object temps réel ;
- [x] audit ;
- [x] détection des garde-fous de plateforme ;
- [x] documentation d’installation.

## Lot 1 — Stabilisation du MVP

- [ ] installer les dépendances et figer `pnpm-lock.yaml` ;
- [ ] créer les ressources Cloudflare de test ;
- [ ] déployer le Worker ;
- [ ] remplacer le jeton global par une session d’appareil ;
- [ ] compléter les tests unitaires ;
- [ ] ajouter des tests E2E Playwright sur pages de test locales ;
- [ ] connecter le WebSocket dans la side panel ;
- [ ] ajouter reprise de mission après redémarrage du navigateur.

### Critères d’acceptation

1. ouvrir une URL HTTP/HTTPS demandée ;
2. refuser les protocoles internes ou fichiers ;
3. lire une page sans collecter les champs secrets ;
4. bloquer toute action externe sans validation ;
5. arrêter la mission sur CAPTCHA ou avertissement ;
6. journaliser chaque étape ;
7. reprendre sans double exécution.

## Lot 2 — Planner LLM contrôlé

- [ ] interface multi-fournisseurs ;
- [ ] sorties JSON strictes ;
- [ ] redaction des données sensibles ;
- [ ] budget et limite de tokens ;
- [ ] fallback déterministe ;
- [ ] tests de prompt injection ;
- [ ] analyse des pages comme données non fiables.

## Lot 3 — Adaptateur Instagram assisté

- [ ] détecter le compte Neptune connecté ;
- [ ] ouvrir une conversation sélectionnée par l’opérateur ;
- [ ] préparer un message ;
- [ ] afficher le destinataire, le texte et l’événement ;
- [ ] envoyer après validation ;
- [ ] enregistrer le résultat ;
- [ ] refuser les doublons ;
- [ ] stopper sur restriction.

La première version Instagram reste **assistée**. La collecte massive et les mécanismes de contournement sont hors périmètre.

## Lot 4 — Neptune Event OS

- [ ] webhook `event.vote_closed` ;
- [ ] calcul des places restantes ;
- [ ] audience newsletter et application ;
- [ ] campagne sociale assistée ;
- [ ] clé d’idempotence par événement et destinataire ;
- [ ] arrêt lorsqu’un événement est complet ;
- [ ] suivi réponses, intérêt et inscription ;
- [ ] statistiques par club.

## Lot 5 — Publication

- [ ] audit de sécurité ;
- [ ] politique de confidentialité ;
- [ ] branding et icônes définitifs ;
- [ ] compte développeur Chrome Web Store ;
- [ ] packaging signé ;
- [ ] pilote sur un seul club ;
- [ ] généralisation après validation des indicateurs.

## Indicateurs du pilote

- taux de missions terminées sans erreur ;
- taux d’actions bloquées correctement ;
- erreurs de ciblage ;
- doublons ;
- avertissements plateforme ;
- temps économisé par événement ;
- taux réponse ;
- taux inscription ;
- taux de refus ou signalement.
