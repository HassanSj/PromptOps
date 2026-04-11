# GitHub setup and copyright-friendly sharing

## Private repository (recommended)

1. Create a **private** repository on GitHub (free for personal use).
2. From the repo root (`promptops/`):

   ```bash
   git init
   git branch -M main
   git remote add origin https://github.com/YOU/promptops.git
   git add .
   git status   # confirm no .env / secrets
   git commit -m "Initial import"
   git push -u origin main
   ```

3. Never commit real secrets. Use only **`.env.example`** / **`.env.local`** patterns; real keys stay in ignored files (see root `.gitignore`).

## What goes on GitHub?

| Approach | What you push | Typical use |
|----------|----------------|-------------|
| **Private repo** | Full source (this monorepo) | Full project; stays non-public. |
| **Public “footprint”** | Only the **`distribution/out/`** folder (see below) | Landing page, legal text, high-level docs — **not** the Next.js / Python / Go source. |

This project does **not** require you to publish full source publicly. For copyright control, keep the application in a **private** repo, or publish only the generated distribution bundle if you need a public artifact.

## Legal-only distribution (no application source)

To build a folder you *can* attach to a public release or mirror without shipping `src/`, `backend/`, `engine/`:

```bash
npm run distribution
```

Output: **`distribution/out/`** (gitignored) containing:

- `LICENSE`, `NOTICE`, `COPYRIGHT`
- `README-DISTRIBUTION.md` (what this bundle is / is not)
- `MANIFEST.txt` (file list)

Keep names and dates in `LICENSE`, `NOTICE`, and `COPYRIGHT` accurate before publishing anything.

## CI (optional)

The included GitHub Actions workflow runs **ESLint** on push/PR. It does not deploy or publish secrets. Extend it when you add tests.

## Questions

- **Patents / licensing:** consult qualified counsel for public releases or customer distribution.
- **Dependencies:** open-source libraries used by the app keep their own licenses; your `LICENSE` file governs *your* original work and how you offer it to others.
