"""Game Server Manager — FastAPI app.

Structure:
  app.main         — FastAPI app + routes
  app.config       — env-backed settings, paths
  app.auth         — bearer token dependency
  app.registry     — read/write server definition YAMLs
  app.control      — systemctl / journalctl / tmux wrappers
  app.uploads      — file upload / download / backup
  app.updater      — self-update trigger (invokes ./update.sh)
  app.types.*      — per-server-type install/update handlers
"""
