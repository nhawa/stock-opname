# Login UI and API fix plan

- [x] Configure Tailwind’s PostCSS integration so the login form styles render.
- [x] Make the frontend API target configuration explicit and prevent the default /api rewrite from proxying localhost:3000 back to itself.
- [x] Add a safe development default that serves the frontend on port 3001 and proxies to the API on port 3000.
- [x] Verify the backend login test and frontend production build.

## Diagnosis

The screenshot shows Tailwind utility styles are not being generated, leaving the login controls unstyled. The frontend lacks Tailwind’s PostCSS plugin/configuration.

The frontend rewrite defaults `API_BACKEND_URL` to `http://localhost:3000`. When the Next frontend is served on port `3000`, `/api/auth/login` is rewritten to the same frontend server, causing a self-proxy loop and a 500/non-JSON response. The API server is intended to run on `3000`, while the frontend should run on `3001` (as documented).
