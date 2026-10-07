// English for the systems area (French key -> English). See ../i18n.js.
export default {
  // algGrenades.js
  "Grenade": "Grenade",
  "Un homme lance une grenade ({range} m, souffle {blast} m) : dégâts, et les hommes autour se jettent à terre. G.":
    "One man throws a grenade ({range} m, {blast} m blast): damage, and the men around it hit the dirt. G.",
  "Fumigène": "Smoke",
  "Un homme lance un fumigène (28 m) : un nuage de ~11 m pendant ~20 s que PERSONNE ne voit ni ne traverse au tir — franchir un terrain découvert, aveugler une mitrailleuse, couvrir un repli. B.":
    "One man throws smoke (28 m): a ~11 m cloud for ~20 s that NOBODY can see or shoot through — cross open ground, blind a machine gun, cover a retreat. B.",

  // algFlares.js
  "Fusée éclairante": "Illumination flare",
  "Une fusée à parachute au-dessus d'un point jusqu'à {range} m : ~{life} s de lumière, le terrain dessous VU et personne n'y reste caché. L'ALN l'évite.":
    "A parachute flare over a point up to {range} m away: ~{life} s of light, the ground below REVEALED and no one stays hidden there. The ALN steers clear of it.",
  "De nuit seulement : une fusée en plein soleil n'éclaire rien.": "Night only: a flare in broad daylight lights up nothing.",

  // algAirStrike.js
  "Ligne coupée": "Line cut",
  "Le FLN a coupé la ligne télégraphique : le poste ne peut plus demander d'avion. Des sapeurs peuvent la réparer (clic droit sur le poteau abattu).":
    "The FLN has cut the telegraph line: the post can no longer call in aircraft. Engineers can repair it (right-click the felled pole).",
  "Avion en route": "Aircraft inbound",
  "Frappe aérienne": "Air strike",
  "Un T-6 mitraille une ligne de {strafe} m jusqu'au point, puis y largue {bombs} bombes. ~{delay} s pour arriver, depuis le poste. Les abris ne protègent pas des bombes. L.":
    "A T-6 strafes a {strafe} m line up to the point, then drops {bombs} bombs on it. ~{delay} s to arrive, from the post. Cover does not protect against bombs. L.",

  // algBarrage.js
  "Tir en cours": "Firing",
  "Tir de barrage": "Barrage",
  "{bombs} obus sur une zone jusqu'à {range} m, {spread} m de large, en ~{secs} s : ils tombent du ciel, aucun abri ne protège. Nettoie un nid de mitrailleuse ou une bande retranchée. M.":
    "{bombs} shells on an area up to {range} m away, {spread} m wide, over ~{secs} s: they fall from the sky, no cover protects. Clears out a machine-gun nest or a dug-in band. M.",

  // algGarrison.js
  "<b>Maison piégée !</b> Une grenade derrière la porte. Faites passer les sapeurs d'abord : ils trouvent les pièges.":
    "<b>Booby-trapped house!</b> A grenade behind the door. Send the engineers in first: they find the traps.",
  "<b>Piège désamorcé</b> par les sapeurs : une grenade derrière une porte.":
    "<b>Trap disarmed</b> by the engineers: a grenade behind a door.",
  "<b>{name}</b> chassé de sa maison !": "<b>{name}</b> driven out of their house!",
  "Le groupe": "The squad",
  "Maison occupée — clic : sélectionner · Sortir (K)": "Occupied house — click: select · Exit (K)",
  "Maison tenue par le FLN — grenades et mortier les en chassent": "House held by the FLN — grenades and mortars drive them out",
  "Sortir": "Exit",
  "Sortir de la maison par la porte.": "Leave the house by the door.",

  // algRepair.js
  "Réparer": "Repair",
  "Réparer un de vos véhicules ou bâtiments endommagés : cliquez dessus (ou clic droit avec des sapeurs sélectionnés). Gratuit ; s'arrête sous le feu.":
    "Repair one of your damaged vehicles or buildings: click it (or right-click with engineers selected). Free; stops under fire.",

  // algMgTeam.js
  "Orienter": "Set arc",
  "Orienter la mitrailleuse : cliquez où elle doit tirer. En batterie, elle pivote (lentement) ; repliée, elle se mettra en batterie face à ce point. O.":
    "Aim the machine gun: click where it should fire. Set up, it turns (slowly); packed up, it will set up facing that point. O.",

  // algTelegraph.js
  "Ligne télégraphique": "Telegraph line",
  "<b>Ligne coupée !</b> Le FLN a abattu un poteau : plus d'appui aérien, et les effectifs d'Alger arrivent moins vite. Envoyez des sapeurs la réparer.":
    "<b>Line cut!</b> The FLN has felled a pole: no more air support, and reinforcements from Algiers arrive more slowly. Send engineers to repair it.",
  "<b>Ligne rétablie.</b> Le poste a de nouveau Alger au bout du fil.":
    "<b>Line restored.</b> The post has Algiers on the line again.",

  // algSniper.js
  "<b>Tireur embusqué !</b> Les tirs viennent de là — montez-y, ou éclairez-le (fusée).":
    "<b>Sniper!</b> The shots are coming from there — move up on him, or light him up (flare).",

  // algAI.js (the assault alert)
  "<b>Attaque du FLN</b> sur {name} !": "<b>FLN attack</b> on {name}!",
  "un avant-poste": "an outpost",
  "des troupes françaises": "French troops",
  "le poste": "the post",

  // algGame.js (loading screen stages)
  "Démarrage du moteur…": "Starting the engine…",
  "Mise en place du décor…": "Setting the scene…",
  "Réglage de la caméra…": "Setting up the camera…",
  "Rassemblement des troupes…": "Mustering the troops…",
  "Usure du terrain…": "Weathering the ground…",
  "Labour des champs…": "Ploughing the fields…",
  "Rentrée des troupeaux…": "Bringing in the herds…",
  "Peinture des surfaces…": "Painting the surfaces…",
  "Préparation des effets…": "Preparing the effects…",

  // alg.html (loading screen: the HTML imports t() itself — the test does not scan .html)
  "Chargement": "Loading",
  "Prêt": "Ready",
  "Échec du démarrage": "Failed to start",
  "Aurès, novembre 1954. Le massif est à eux ; les vallées sont à vous.": "Aurès, November 1954. The massif is theirs; the valleys are yours.",
  "Le poste forme des appelés : sa porte s'ouvre pour chaque homme qu'il envoie.": "The post trains appelés: its gate opens for every man it sends out.",
  "Le haut de la minicarte est tourné vers l'ennemi — votre poste est en bas.": "Up on the minimap is toward the enemy — your post is at the bottom.",
  "Q / E tournent la caméra, la molette zoome, C la libère.": "Q / E turn the camera, the wheel zooms, C frees it.",
  "Ctrl + un chiffre crée un groupe ; le chiffre le rappelle.": "Ctrl + a number makes a control group; the number calls it back.",
  // maps/aures.js — the supply points (descriptions; the village names stay)
  "Puits d'Ain Tighanimine": "Ain Tighanimine well",
  "Carrefour de la piste": "Track crossroads",
  "Gué de l'oued": "Wadi ford",
  "Col du ravin": "Ravine pass",
  "Source d'Aïn Kerma": "Aïn Kerma spring",
  "Débouché du ravin": "Ravine mouth",
};
