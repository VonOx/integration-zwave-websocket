# Z-Wave (zwave-js-ui)

Ceci est la documentation utilisateur de l'intégration. Gladys ré-héberge ce
fichier et affiche un lien **Documentation** permanent vers lui dans l'écran
de configuration (dans la langue de l'utilisateur, avec l'anglais en repli) —
c'est au moment de configurer que l'utilisateur en a le plus besoin.

## Ce que vous obtenez

Cette intégration se connecte à [zwave-js-ui](https://zwave-js.github.io/zwave-js-ui/#/)
via son **API Socket.IO native** — la même que celle utilisée par son propre
tableau de bord web. Chaque nœud de votre réseau Z-Wave devient un appareil
Gladys, avec une fonctionnalité par valeur exposée (niveau du variateur, état
de l'interrupteur, mesure de capteur, batterie, etc.). Les nœuds et endpoints
ajoutés/retirés sont pris en compte automatiquement, sans liste statique à
maintenir.

Les charges variables (Multilevel Switch) sont classées selon la classe
d'appareil Z-Wave propre au nœud : les variateurs de vitesse de ventilateur
apparaissent comme une vitesse de ventilateur, les volets/stores motorisés
comme une position de volet, tout le reste comme une luminosité de lampe.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Renseignez l'**Hôte** et le **Port** de votre instance zwave-js-ui.
   - ⚠️ Utilisez le **port de l'interface web** (`8091` par défaut) — **pas**
     le port de `zwave-js-server` (`3000`) ; cette intégration ne parle pas ce
     protocole.
3. Activez **Utiliser HTTPS/WSS** si zwave-js-ui est servi derrière TLS (ex.
   reverse proxy).
4. Activez **Authentification requise** uniquement si votre instance
   zwave-js-ui a elle-même la connexion activée (son propre réglage « Auth
   enabled ») et renseignez le **Nom d'utilisateur**/**Mot de passe**
   correspondants.
5. Enregistrez : l'intégration se connecte, et vos nœuds apparaissent dans
   l'onglet **Découverte**.

## Actions

- **Tester la connexion** — se connecte à zwave-js-ui et indique le nombre de
  nœuds détectés.
- **Identifier un appareil** — choisissez un de vos appareils dans la liste.
  Cela ne fonctionne que sur les nœuds exposant la valeur « identify » de la
  Command Class Indicator ; sur les autres, un message indique que l'appareil
  n'a aucun moyen de se signaler.

## Dépannage

- **« Configurez d'abord l'hôte zwave-js-ui »** — les champs Hôte/Port sont
  vides ou incomplets ; renseignez-les puis enregistrez.
- **La connexion échoue juste après l'enregistrement** — vérifiez le port
  (8091, pas 3000) et que **Authentification requise** correspond exactement
  au réglage « Auth enabled » de zwave-js-ui ; un décalage d'un côté ou de
  l'autre fait échouer la connexion.
- **Un appareil affiche un badge « unreachable »** — le nœud Z-Wave
  correspondant est signalé mort/indisponible dans zwave-js-ui. L'appareil
  n'est jamais supprimé : il redevient normal dès que le nœud est de nouveau
  joignable.
- L'intégration journalise tout ce qu'elle fait : consultez les logs de
  l'intégration depuis l'interface Gladys (ou `docker logs` sur l'hôte) avec
  `LOG_LEVEL=debug` pour le détail complet.
