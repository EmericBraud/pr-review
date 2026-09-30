# PR Review

Review des pull requests GitHub dans VS Code. Utilise le token de `gh` (`gh auth token`), avec repli sur le compte GitHub de VS Code.

## Installation

```bash
npm install && npm run package
code --install-extension pr-review-0.1.0.vsix
```

Ouvre ensuite un dossier dont le remote git (`upstream` ou `origin`) pointe vers github.com. Une icône **PR Review** apparaît dans la barre d'activité.

## Fonctionnalités

**Pull Requests** (vue du haut)
- Trois groupes : *En attente de ma review* (compteur sur l'icône), *Créées par moi*, *Toutes les PRs ouvertes*. La couleur de l'icône donne l'état de la CI, la description l'état de la review.
- Au survol : icône œil (review), checkout, ouvrir sur GitHub. Un clic ouvre la vue détail.

**Vue détail d'une PR**
- Description, reviewers, labels, conflits.
- Checks CI : les échecs sont dépliés avec le résumé, les annotations (un clic ouvre le fichier à la bonne ligne) et **View log** (log du job GitHub Actions, positionné sur la première `##[error]`). Les checks verts sont repliés.
- Commits (un clic lance la review de ce commit), commentaires de code, conversation, et un champ pour commenter la PR.

**Review** (vue du bas)
- **PR complète** : arborescence des fichiers (dossiers communs regroupés, chaînes de dossiers compactées comme dans l'explorateur), avec une case *viewed* **synchronisée avec GitHub** (même état que sur github.com). Un dossier est coché quand tous ses fichiers sont vus (sinon il affiche `2/5`) ; le cocher coche tous ses fichiers.
- **Commit par commit** : chaque commit (titre, auteur, message complet au survol et en haut de la vue) avec l'arborescence de ses fichiers à cocher. Quand un fichier est coché dans tous les commits qui le touchent, il passe en *viewed* sur GitHub.
- Changer de mode : bouton dans le titre de la vue, ou clic sur la barre d'état. ↑/↓ pour passer au commit précédent/suivant.
- `Alt+N` (ou ✓ dans le titre du diff) : marque le fichier comme vu et ouvre le suivant.
- Bouton « Open File in Workspace » dans le titre du diff : ouvre le vrai fichier. Si la branche de la PR est checkoutée, les lignes modifiées y sont surlignées (lignes supprimées : trait rouge), et on peut commenter directement dans le code. Le bouton « Open Pull Request Diff » sur le fichier fait le chemin inverse.

**Commentaires**
- `+` dans la marge sur les lignes du diff (glisser pour sélectionner plusieurs lignes) → **Start Review** (review en attente sur GitHub) ou **Add Single Comment** (publié tout de suite).
- Répondre, modifier/supprimer ses commentaires, résoudre/rouvrir un fil.
- **Submit Review…** (double coche dans le titre de la vue) : Comment / Approve / Request changes, avec un résumé. **Discard Pending Review** dans le menu `…`.

## Limites connues
- github.com uniquement (pas GitHub Enterprise).
- Commit par commit : on ne peut commenter que les fichiers qui n'ont pas été modifiés par un commit suivant (sinon les lignes ne correspondent plus au diff de la PR).
- 100 premiers fils de commentaires par PR ; fichiers binaires affichés en texte.

## Développement

```bash
npm test                                                   # tests unitaires (parseur de diff)
npm run test:integration -- <clone d'un repo GitHub> <n° de PR> [id de job Actions]   # lance un VS Code isolé, lecture seule
SUITE=writes npm run test:integration -- <clone du sandbox> 1   # écritures (commentaires, reviews, viewed) : uniquement sur EmericBraud/pr-review-sandbox
```
