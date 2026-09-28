# Secure Note Vault — Feature Roadmap

**Purpose:** Turn Secure Note Vault into a premium, local-first desktop notes application with strong privacy, useful daily workflows, and a cinematic interface.

**Existing foundation:** Desktop note editor, vault authentication, note navigation, and local encrypted storage. Verify security claims against the actual implementation before storing sensitive information.

## Implementation status — September 2026

| Feature | Status |
|---|---|
| Universal command palette | Partial: commands and shortcuts are available; palette search/navigation can still expand |
| Advanced Markdown editor | Partial: preview, formatting, checklists, autosave and history are available |
| Interactive knowledge graph | Implemented: local related-note graph with clickable nodes and zoom |
| Note version history | Implemented with encrypted snapshots and safe restore; comparison and configurable retention remain |
| Multiple note views | Implemented: list, cards, drag-and-drop Kanban and calendar |
| Protected credential cards | Implemented: masked fields, generated passwords, timed remasking and secure clipboard clearing |
| Security dashboard | Partial: live diagnostics exist; event history and stale-backup reminders remain |
| Encrypted file attachments | Implemented with in-memory previews and Apple Vision OCR |
| Daily journal and templates | Implemented: daily focus, four templates, calendar browsing and local task reminders |
| Completely offline AI assistant | Partial: local extractive search, answers, summaries, tags and related notes; no bundled LLM yet |
| Global quick capture | Implemented: `Command + Shift + N` opens an authenticated, always-on-top capture window |
| Personal productivity dashboard | Implemented: Action Center, aggregated checklist tasks, quick capture, activity heatmap, focus notes and private reminders |

Sensitive preview, OCR, credential reveal, recovery-code and intelligence state is explicitly cleared when the vault locks.

## 1. Features that transform the app

### 1. Universal command palette — High priority
- Open with `⌘ + K`.
- Search notes, folders, tags, and application commands.
- Create a note, switch themes, navigate, or lock the vault without using the mouse.
- Show a polished floating search panel with keyboard navigation.

### 2. Advanced Markdown editor — High priority
- Live Markdown preview and formatting toolbar.
- Syntax-highlighted code blocks, tables, checklists, and internal note links.
- Automatic saving, undo history, and keyboard shortcuts.
- Distraction-free focus mode.

### 3. Interactive knowledge graph — Signature feature
- Visualize connections between notes using links and shared tags.
- Click nodes to open notes and zoom into related topics.
- Keep graph data local and protected with the vault.

### 4. Note version history
- Create encrypted snapshots of note revisions.
- Browse a timeline and compare versions side by side.
- Restore previous versions without discarding the current version.
- Offer configurable history retention.

### 5. Multiple note views
- List, card, Kanban, and calendar views.
- Use Kanban for project notes and calendar view for journal entries.
- Keep all views backed by the same encrypted database.

## 2. Features that distinguish the vault

### 6. Protected secrets and credential cards — Security
- A dedicated note type for usernames, passwords, API keys, server URLs, and related notes.
- Mask sensitive fields by default, with explicit reveal controls.
- Automatically remask fields and optionally clear copied secrets from the clipboard.
- Never show sensitive fields in note previews or notifications.
- **Boundary:** This is initially an organizational feature, not a substitute for an independently audited password manager.

### 7. Security dashboard
- Show encryption configuration, auto-lock settings, backup status, and local security events.
- Provide backup recovery tests and reminders when backups are outdated.
- Clearly distinguish configured protections from protections actually verified by tests.

### 8. Encrypted file attachments
- Attach PDFs, screenshots, images, documents, and configuration files.
- Encrypt attachment contents and filenames.
- Preview attachments only while the vault is unlocked.
- Avoid unencrypted temporary files and clear previews when the vault locks.

### 9. Daily journal and templates
- One-click templates for journals, meetings, technical documentation, project plans, and personal goals.
- Calendar and timeline browsing.
- Optional local daily writing reminders.

## 3. Advanced features for later releases

### 10. Completely offline AI assistant
- Run a local model through Ollama or llama.cpp.
- Summarize notes, answer questions about documents, organize ideas, and suggest related notes.
- Do not send notes to an external AI service without explicit permission.
- Keep any search index or model cache protected and remove sensitive data on lock where practical.

### 11. Global quick capture
- Open a small floating note window using a global keyboard shortcut.
- Capture ideas and return immediately to the previous application.
- Require authentication when the vault is locked.

### 12. Personal productivity dashboard
- Show writing activity, recent notes, unfinished checklists, frequently visited notes, and a calendar heatmap.
- Keep analytics entirely on-device.
- **Implemented:** The Action Center aggregates Markdown tasks, updates their source notes, provides a 12-week encrypted activity view, and schedules generic-content macOS notifications.

## 4. Suggested implementation order

| Release | Feature | Priority |
|---|---|---|
| Next | Universal command palette | High |
| Next | Advanced Markdown editor | High |
| Next | Auto-save and version history | High |
| Next | Security dashboard | High |
| Next | Protected credential cards | High |
| Next | Encrypted attachments | Medium |
| Next | Global quick capture | Medium |
| Later | Interactive knowledge graph | Medium |
| Later | Multiple note views | Medium |
| Later | Daily journal and templates | Medium |
| Later | Offline AI assistant | Advanced |
| Complete | Productivity dashboard | — |

## 5. Design direction

Use a cinematic, premium desktop visual language while prioritizing legibility and speed:
- Deep charcoal or midnight-blue surfaces with restrained violet and electric-blue accents.
- Carefully layered translucent panels, subtle shadows, and generous spacing.
- Smooth, purposeful animations for navigation, command palette, locking, and note transitions.
- A polished three-column workspace: navigation, searchable note list, and editor, with an optional contextual information panel.
- Accessible contrast, clear focus states, keyboard-first interaction, and reduced-motion support.
- Keep sensitive note content out of OS notifications, window previews, and decorative UI.

## 6. Security requirements before expansion

Before storing real credentials or adding advanced features:
1. Verify database and backup encryption through tests.
2. Test unlock, manual lock, auto-lock, and master-password changes.
3. Confirm logs and error reports contain no secrets or note contents.
4. Test backup creation and restoration on a clean installation.
5. Review key handling, temporary files, search indexes, clipboard behavior, and the Tauri IPC boundary.
6. Document the limits of protection against malware or an attacker with access to an unlocked computer.

**Principle:** Build an impressive interface on top of a verified, reliable encrypted vault—not in place of one.
