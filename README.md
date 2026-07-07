# 💃 Salsa Vault

A personal vault for salsa tutorials. Fully static — no backend, no database:

- **Videos** upload from your browser straight to **your YouTube account as unlisted**
- **Metadata** (name, tags, notes) lives in [`moves.json`](moves.json), committed back to this repo via the GitHub API
- Hosted free on **GitHub Pages**, designed mobile-first

```
index.html   app shell (library / new move / detail+edit views)
styles.css   all styling — the color scheme is the block at the very top
app.js       search, filters, YouTube upload, GitHub saves
config.js    your Google client ID + repo details  ← fill this in
moves.json   the "database"
```

## Changing the look

Open `styles.css`. The **theme block at the top** is the entire color
scheme — light mode and dark mode side by side, each value commented.
Change `--accent` and you've rebranded the app.

## One-time setup

### 1. Put it on GitHub Pages

1. Push these files to `main` of the repo named in `config.js`
   (currently `Ithrendrial/salsa-tutorials`)
2. Repo → Settings → Pages → Source: *Deploy from a branch* → `main` / root

Your app is now at `https://ithrendrial.github.io/salsa-tutorials/`

### 2. Google / YouTube (for uploads)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create a project
2. **APIs & Services → Library** → enable **YouTube Data API v3**
3. **APIs & Services → OAuth consent screen** → External → fill the basics,
   then under **Audience / Test users** add your own Google account
   (leave the app in *Testing* — no verification needed for personal use)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   → type *Web application* → add **Authorized JavaScript origins**:
   - `https://ithrendrial.github.io`
   - `http://localhost:8000` (for local testing)
5. Copy the client ID into `config.js`

### 3. GitHub token (for saving moves)

The first time you save, the app asks for a token (stored only in your
browser's localStorage — once per device).

1. GitHub → Settings → Developer settings →
   [Fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new)
2. Repository access: **only this repo** · Permissions: **Contents → Read and write**
3. Paste it into the app when prompted

## Running locally

```sh
python3 -m http.server 8000
```

then open http://localhost:8000

## Good to know

- **Upload quota:** YouTube's default API quota allows ~6 uploads/day
  (each upload costs 1600 of the 10,000 daily units). Plenty for classes;
  a quota increase can be requested from Google if ever needed.
- **Unlisted, not private:** unlisted videos play in the embedded player
  but don't appear in search or on your channel page. (Truly *private*
  videos can't be embedded at all.)
- **If a save fails** after a video uploaded, the move is kept in your
  browser and re-saved automatically on your next visit — nothing is lost.
- **Editing YouTube itself:** edits here update the vault, not the video's
  title/description on YouTube. The vault is the source of truth.
- **Whose YouTube account gets the video:** the client ID in `config.js`
  isn't tied to one channel — whoever signs in at the upload popup is
  where the video lands. To hand this off to someone else, add their
  Google account under **OAuth consent screen → Audience → Test users**
  (Google Cloud console) — until they're on that list, an unverified
  Testing app will block their sign-in. Once added, they just open the
  app and sign in with their own account; no code or config changes.
