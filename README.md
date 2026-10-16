# Together

Private, shared to-do lists for friends and small groups. Self-hosted with Node.js 24 and SQLite.

- Shared lists, task notes, search, and live updates.
- Invite-only accounts with owner-managed access.
- Responsive layout with light and dark themes.

## Quick start

```sh
docker compose up -d --build
```

Open [localhost:3000](http://localhost:3000), create the owner account, and share invitation links with friends. Create the owner account before making the app publicly accessible. Data persists in a Docker volume.

## Configuration

Copy `.env.example` to `.env` to customize the public `APP_URL`, `PORT`, and `BIND_ADDRESS`. Use HTTPS for public hosting. For direct LAN access, set `BIND_ADDRESS=0.0.0.0` and `APP_URL` to your server's address.

Without Docker: run `npm start` with Node.js 24+; no dependencies to install. Checks: `npm run check` and `npm test`.

## Screenshots

| Desktop · dark theme | Mobile · light theme |
| --- | --- |
| <img src="docs/screenshots/desktop-dark.png" alt="Shared to-do list on desktop in dark mode" width="640"> | <img src="docs/screenshots/mobile-light.png" alt="Shared to-do list on mobile in light mode" width="200"> |
