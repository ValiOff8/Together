# Together

Self-hosted shared tasks, collaborative notes, and temporary file sharing.

## Features

- **Lists:** Multiple private lists, color labels, and per-person view or edit permissions.
- **Tasks:** Optional notes, search, All / To do / Done filters, progress, and completion tracking.
- **Bulk actions:** Check off remaining tasks or delete completed tasks after confirmation.
- **Task details:** Creation and update information, plus who completed a task and when.
- **Shared text:** Multiple sheets, automatic saving, concurrent editing, rename/delete, and up to 100,000 characters per sheet.
- **Markdown:** Live preview with headings, tables, checklists, links, and code blocks; export as `.txt` or `.md`.
- **Files:** Multiple uploads, drag and drop, upload progress, filename search, downloads, and manual deletion.
- **Automatic cleanup:** Files expire after 48 hours by default; adjustable from 1 minute to 30 days.
- **Upload limits:** 10 GiB per file by default; configurable by the notebook owner.
- **Invitations:** Email-bound, single-use links, valid for 7 days and revocable. Share links yourself; no email is sent.
- **Access control:** New lists stay private until shared. Only the list creator can manage access or delete the list.
- **Live updates:** Synced changes, collaborator avatars, and connection status.
- **Accounts:** Password changes, sign-out, member removal, and server-side password recovery.
- **Appearance:** Responsive desktop/mobile layouts, light/dark themes, and remembered list, view, and filter selections.
- **Self-hosting:** Docker Compose or Node.js 24+, SQLite, persistent local storage, and no dependencies to install.

## Quick start

```sh
docker compose up -d --build
```

Open [localhost:3000](http://localhost:3000). Create the owner account before public access, then invite people and share lists.

Configure Docker Compose through `.env.example` → `.env`. Use HTTPS for public hosting. Docker persists data in `together-data`; back up both the database and uploaded files.

Without Docker: run `npm start` with Node.js 24+. Set configuration through environment variables. Checks: `npm run check` and `npm test`.

## Screenshots

All names and content below are fictional examples. Most screenshots use dark mode; the final row shows light mode.

| | |
| --- | --- |
| <img src="docs/screenshots/desktop-dark.png" alt="Shared tasks in dark mode" width="560"><br><sub>Tasks, notes, filters, and progress.</sub> | <img src="docs/screenshots/task-details-dark.png" alt="Task details dialog" width="560"><br><sub>Edit notes and check task history.</sub> |
| <img src="docs/screenshots/desktop-text-dark.png" alt="Shared text editor" width="560"><br><sub>Multiple sheets with automatic saving.</sub> | <img src="docs/screenshots/desktop-markdown-dark.png" alt="Markdown preview" width="560"><br><sub>Preview tables, checklists, and formatted notes.</sub> |
| <img src="docs/screenshots/text-download-dark.png" alt="Text export options" width="560"><br><sub>Download as plain text or Markdown.</sub> | <img src="docs/screenshots/list-access-dark.png" alt="List permissions" width="560"><br><sub>Choose who can view or edit.</sub> |
| <img src="docs/screenshots/invite-dark.png" alt="Invitations and members" width="560"><br><sub>Invite friends and manage members.</sub> | <img src="docs/screenshots/notebook-settings-dark.png" alt="Notebook settings" width="560"><br><sub>Rename the notebook and set upload limits.</sub> |
| <img src="docs/screenshots/file-share-desktop-dark.png" alt="Shared files on desktop" width="560"><br><sub>Search, download, and manage shared files.</sub> | <img src="docs/screenshots/file-share-mobile-dark.png" alt="Shared files on mobile" width="200"><br><sub>File sharing on mobile.</sub> |
| <img src="docs/screenshots/file-share-drag-and-drop.png" alt="File drop area" width="560"><br><sub>Drag files into the upload area.</sub> | <img src="docs/screenshots/file-share-upload-dark.png" alt="Upload progress" width="560"><br><sub>Track upload progress.</sub> |
| <img src="docs/screenshots/file-share-expiry-dark.png" alt="File deletion timer" width="560"><br><sub>Set automatic deletion times.</sub> | <img src="docs/screenshots/mobile-dark.png" alt="Tasks on mobile in dark mode" width="200"><br><sub>Manage tasks on mobile.</sub> |
| <img src="docs/screenshots/desktop-light.png" alt="Desktop light theme" width="560"><br><sub>Light mode on desktop.</sub> | <img src="docs/screenshots/mobile-light.png" alt="Mobile light theme" width="200"><br><sub>Light mode on mobile.</sub> |

[MIT License](LICENSE) · Copyright © 2026 ValiOff8.
