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

Set `LOCAL_NAME_LOGIN=true` only on trusted local networks to sign in with a name alone (no email, password, or invitation). Existing names reuse their accounts; new names create members, or the owner on an empty installation. List permissions and session cookies still apply, but anyone who can reach the app can impersonate any name, including the owner. Keep this mode disabled for public hosting. Set it to `false` to restore password login; existing passwords are preserved.

Copy `.env.example` to `.env` to customize the public `APP_URL`, `PORT`, and `BIND_ADDRESS`. Use HTTPS for public hosting. For direct LAN access, set `BIND_ADDRESS=0.0.0.0` and `APP_URL` to your server's address.

For an additional reverse-proxy address, set `APP_ALLOWED_ORIGINS` to a comma-separated list of exact HTTP(S) origins, for example `http://together.example.test`. Keep `APP_URL` set to the existing address to retain its origin. Wildcards, paths, and credentials are not accepted; authentication and cross-site request checks still apply. Preserve the original `Host` and `Origin` headers at the proxy instead of rewriting origins.

Without Docker: run `npm start` with Node.js 24+; no dependencies to install. Checks: `npm run check` and `npm test`.

Source code lives in `src/server/` (Node.js and SQLite) and `src/web/` (browser UI). Tests live in `tests/`.

Text sheets support up to 100,000 characters each. Keep the tab open until it says “All changes saved”; if saving fails, retry or download the local text using the document toolbar.

## File sharing

Open a list and select the **File share** icon beside the task and text document icons.

- Select **Upload files** to choose one or more files, or drag them into the **Drop your files here** area. The area highlights while dragging; uploads show the filename, percentage, and a progress bar. Each file can be up to 10 GB.
- Uploaded files appear one below another with their filename, size, uploader, and remaining time. Use **Search files** to filter by filename and the download button to save a copy.
- Use the **clock button beside download** to change a file’s deletion time. Choose a duration in minutes, hours, or days, from **1 minute to 30 days**. The new countdown starts when you save; the dialog also shows the currently scheduled deletion time.
- Use the trash button to delete a file immediately after confirming. Readers can download files; list owners and editors can also upload, change deletion times, and delete files.

Every completed upload starts with a **48-hour** lifetime. The server automatically deletes expired files from storage and updates connected browsers, even when no one has the list open. Downloads stop at expiry, and expired files cannot be extended. If the server was stopped, it cleans up overdue files on restart. Deleting a list also deletes its shared files.

### File storage

Files are stored on the server beside the SQLite database:

| Environment | Database | Uploaded files |
| --- | --- | --- |
| Local defaults | `data/together.sqlite` | `data/together.sqlite-files/` |
| Docker | `/app/data/together.sqlite` | `/app/data/together.sqlite-files/` |

Docker keeps both in the existing `together-data` volume. With a custom `DATABASE_PATH`, the upload directory is named `<database filename>-files/` in the same directory as that database. Files use random IDs on disk; their original names, sizes, uploaders, and deletion times are stored in SQLite. Back up both the database and its upload directory to preserve shared files.

## List permissions

New lists are private to their creator. Invite people to the notebook, then open a list’s **List options → Manage access** to give individual members **Can view**, **Can edit**, or **No access**. Changes take effect immediately on the server and refresh in connected tabs. Viewers can read tasks and download text sheets and shared files; editors can also rename the list, change its tasks and sheets, upload or delete files, and adjust file deletion times. Only the list creator can manage access or delete the whole list. Deleting a list also deletes its uploaded files. The notebook owner has no automatic access to another member’s private lists.

On the first upgrade, existing lists belong to the notebook owner and keep edit access for all existing members. Newly invited members receive no automatic list access. This migration runs once; subsequent restarts preserve private lists and permissions.

Removing a member revokes their sessions and list grants. Members who own lists must delete those lists before their account can be removed; removing an account never silently exposes or deletes its private lists. A revoked reader’s browser clears the list on its next successful refresh, but access controls cannot retract copies someone already read or downloaded.

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
