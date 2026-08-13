# Z-Wave (zwave-js-server)

Ceci est la documentation utilisateur de l'intégration. Gladys ré-héberge ce
fichier et affiche un lien **Documentation** permanent vers lui dans l'écran
de configuration (dans la langue de l'utilisateur, avec l'anglais en repli) —
c'est au moment de configurer que l'utilisateur en a le plus besoin.

## Ce que vous obtenez

Cette intégration se connecte à [zwave-js-ui](https://zwave-js.github.io/zwave-js-ui/#/)
via **zwave-js-server** — la passerelle WebSocket documentée qu'il peut
exposer en option, le même protocole qu'utilisent nativement l'intégration
Z-Wave JS de Home Assistant, ioBroker et Node-RED. Chaque nœud de votre réseau
Z-Wave devient un appareil Gladys, avec une fonctionnalité par valeur exposée
(niveau du variateur, état de l'interrupteur, mesure de capteur, batterie,
etc.). Les nœuds et endpoints ajoutés/retirés sont pris en compte
automatiquement, sans liste statique à maintenir.

Les charges variables (Multilevel Switch) sont classées selon la classe
d'appareil Z-Wave propre au nœud : les variateurs de vitesse de ventilateur
apparaissent comme une vitesse de ventilateur, les volets/stores motorisés
comme une position de volet, tout le reste comme une luminosité de lampe.

## Configuration

1. Dans zwave-js-ui, allez dans **Paramètres > Z-Wave** et activez
   **« ZwaveJS server »**, en notant le port sur lequel il écoute (`3000` par
   défaut).
2. Ouvrez l'onglet **Configuration** de l'intégration.
3. Renseignez l'**Hôte** de votre instance zwave-js-ui et le **Port** de
   zwave-js-server obtenu à l'étape 1.
4. Activez **Utiliser HTTPS/WSS** si zwave-js-server est servi derrière TLS
   (ex. reverse proxy).
5. Enregistrez : l'intégration se connecte, et vos nœuds apparaissent dans
   l'onglet **Découverte**.

zwave-js-server n'a aucune authentification au niveau du protocole — il n'y a
rien d'autre à configurer.

## Actions

- **Tester la connexion** — se connecte à zwave-js-server et indique le
  nombre de nœuds détectés.
- **Identifier un appareil** — choisissez un de vos appareils dans la liste.
  Cela ne fonctionne que sur les nœuds exposant la valeur « identify » de la
  Command Class Indicator ; sur les autres, un message indique que l'appareil
  n'a aucun moyen de se signaler.

## Dépannage

- **« Configurez d'abord l'hôte zwave-js-server »** — les champs Hôte/Port
  sont vides ou incomplets ; renseignez-les puis enregistrez.
- **La connexion échoue juste après l'enregistrement** — vérifiez le port : ce
  doit être celui de zwave-js-server (`3000` par défaut), pas celui de
  l'interface web de zwave-js-ui (`8091` par défaut) — ce sont deux
  passerelles distinctes.
- **Un appareil affiche un badge « unreachable »** — le nœud Z-Wave
  correspondant est signalé mort/indisponible. L'appareil n'est jamais
  supprimé : il redevient normal dès que le nœud est de nouveau joignable.
- L'intégration journalise tout ce qu'elle fait : consultez les logs de
  l'intégration depuis l'interface Gladys (ou `docker logs` sur l'hôte) avec
  `LOG_LEVEL=debug` pour le détail complet.
