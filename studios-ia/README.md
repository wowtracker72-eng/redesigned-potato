# Studios IA

12 outils web pour créer images, vidéos et films avec l'API [Agnès AI](https://platform.agnes-ai.com). Ils remplacent les 45 fichiers `deepseek_html_*` des dépôts `redesigned-potato` et `Agnes-ai-story-bord-maker-for-Google-flow-`.

Ouvrez `index.html` dans le navigateur, cliquez sur **🔑 Mes clés API**, puis choisissez un studio. Les clés sont saisies une seule fois et servent à tous les studios. Elles restent dans ce navigateur.

| Fichier | Fonction | Remplace |
|---|---|---|
| `film-ia.html` | Idée ou photos → scénario → plans → court-métrage narré | Kata Studio (×4), Studio d'Auteur, Ciné Studio, ViMax |
| `plan-sequence.html` | Photo → film en un seul plan continu (ou montage), sur l'actualité ou une histoire | Plan-Séquence v15, v23, v26, Studio Plan-Séquence (×6) |
| `dessin-anime.html` | Idée → fiche personnage → scènes animées | Dessin Animé IA |
| `storyboard-google-flow.html` | Scénario → jusqu'à 100 plans (image + prompt Veo) avec export TXT/CSV | Film Storyboard Lab (×3) |
| `jt-actualite.html` | Titres du jour → JT filmé, style de réalisateur et palette au choix | NewsReel Studio (×4), Cinéma Studio JT (×5) |
| `journal-visuel.html` | Image de référence → journal filmé (discours ou Chœur intellectuel) | VISUAL.JOURNAL, Journal Visuel, Chœur (×4) |
| `studio-photo.html` | Photo → blocs de styles, personnages, décors, histoire → film ; sessions et favoris | 8 variantes « Studio », Portrait 9:16, 50 Styles Lab |
| `copies-image.html` | Image → lots de copies fidèles, structurées, restylées + variations | Copy Studio |
| `transfert-style.html` | Style d'une image → appliqué à vos photos → animé | Style Studio |
| `scenes-multi-angles.html` | Une scène filmée sous 40 angles de caméra | Scene Studio |
| `photos-en-videos.html` | Chaque image devient un clip animé | MoneyPrinterTurbo · Agnès |
| `generateur-applications.html` | Une phrase → une appli IA (formulaire + étapes), sauvegarde et lien de partage | APPFORGE |

`commun/agnes.js` et `commun/studio.css` sont partagés par tous les studios. Gardez le dossier `commun/` à côté des pages.

## Bugs corrigés par rapport aux anciennes versions
- Les appels texte consommaient le quota **vidéo** (1/min en gratuit) : les analyses et scénarios bloquaient pendant une minute.
- Les requêtes n'avaient pas de délai maximal : une requête bloquée figeait toute la génération.
- Le décodage des identifiants vidéo échouait quand ils contenaient `-` ou `_` (base64url).
- Le bouton Arrêter ne coupait pas les requêtes en cours.
- Une erreur 500 ou un réseau coupé faisait échouer l'image au lieu de réessayer.
- La file vidéo saturée (503) n'était gérée que dans certaines versions.
- Le JSON renvoyé par l'IA était parfois rejeté (balises `<think>`, virgules finales, retours à la ligne).
- L'affichage se figeait quand l'onglet passait en arrière-plan.
- Chaque fichier redemandait les clés et gardait son propre réglage de débit.
