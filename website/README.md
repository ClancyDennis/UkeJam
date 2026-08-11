# ukejam website

Static marketing + App Store compliance site for the ukejam iOS app, served by
nginx and packaged for Google Cloud Run.

## Pages

| URL | File | Purpose |
|-----|------|---------|
| `/` | `public/index.html` | Marketing / landing page (App Store "Marketing URL") |
| `/support` | `public/support.html` | Support + FAQ (App Store "Support URL" — required) |
| `/privacy` | `public/privacy.html` | Privacy policy (required by App Store Connect; covers microphone use) |
| `/terms` | `public/terms.html` | Terms of Use / EULA (optional but recommended) |

Clean URLs work via nginx `try_files` (`/privacy` → `privacy.html`); the `.html`
paths also resolve. Unknown paths get the styled `404.html`.

## Deploy to Cloud Run

One command from this directory (uses Cloud Build, no local Docker needed):

```bash
gcloud run deploy ukejam-website \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

Cloud Run injects `PORT`; the nginx image's entrypoint substitutes it into
`nginx/default.conf.template` at startup, so the container honors whatever port
Cloud Run assigns (8080 by default).

To use a custom domain (e.g. `ukejam.app`), map it after the first deploy:

```bash
gcloud run domain-mappings create --service ukejam-website --domain ukejam.app
```

## Local preview

```bash
docker build -t ukejam-website .
docker run --rm -p 8080:8080 ukejam-website
# open http://localhost:8080
```

Or without Docker (no clean URLs, but fine for content checks):

```bash
python3 -m http.server 8080 --directory public
```

## App Store Connect values

Once deployed, plug the service URL (or your mapped domain) into App Store
Connect:

- **Support URL:** `https://<your-domain>/support`
- **Marketing URL:** `https://<your-domain>/`
- **Privacy Policy URL:** `https://<your-domain>/privacy`

## Updating content

Everything is hand-written static HTML/CSS in `public/` — edit and redeploy.
The shared stylesheet is `public/styles.css`, which mirrors the app's palette
(`app/src/styles.css`). Brand images (`icon.png`, `ukejam-mark.png`) are copies
of the app's assets.
