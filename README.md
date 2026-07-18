# 💃 Salsa Roja

A personal app for salsa tutorials. Fully static — no backend, no database.

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