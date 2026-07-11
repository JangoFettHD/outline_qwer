#!/usr/bin/env python3
"""Send a backup report email with optional attachments.

Used by backup-db.sh. SMTP credentials and recipients come from environment
variables (populated by the caller from /opt/outline/.backup-env):

    SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM
    BACKUP_EMAIL_TO   comma-separated recipient list

Usage:
    backup-email.py --subject "..." --body "..." [--attach FILE ...]

Attachments are gzip/tar files; anything over ATTACH_LIMIT_BYTES total is
skipped (the caller mentions S3 links in the body instead). Exit code is
non-zero if the SMTP transaction fails, so the caller can log delivery
failures without silently losing them.
"""

import argparse
import os
import smtplib
import sys
from email.message import EmailMessage
from pathlib import Path

ATTACH_LIMIT_BYTES = 20 * 1024 * 1024  # keep well under Gmail's 25 MB cap


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", required=True)
    parser.add_argument("--body", required=True)
    parser.add_argument("--attach", nargs="*", default=[])
    args = parser.parse_args()

    host = os.environ["SMTP_HOST"]
    port = int(os.environ.get("SMTP_PORT", "587"))
    username = os.environ["SMTP_USERNAME"]
    password = os.environ["SMTP_PASSWORD"]
    sender = os.environ.get("SMTP_FROM", username)
    recipients = [
        r.strip() for r in os.environ["BACKUP_EMAIL_TO"].split(",") if r.strip()
    ]
    if not recipients:
        print("BACKUP_EMAIL_TO is empty", file=sys.stderr)
        return 2

    msg = EmailMessage()
    msg["Subject"] = args.subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)

    body = args.body

    # Attach files while the running total stays under the limit; list any
    # skipped files in the body so the reader knows to fetch them from S3.
    total = 0
    skipped = []
    to_attach = []
    for name in args.attach:
        p = Path(name)
        if not p.is_file():
            skipped.append(f"{name} (missing)")
            continue
        size = p.stat().st_size
        if total + size > ATTACH_LIMIT_BYTES:
            skipped.append(f"{p.name} ({size // (1024 * 1024)} MB — too large)")
            continue
        total += size
        to_attach.append(p)

    if skipped:
        body += "\n\nNot attached (fetch from S3):\n" + "\n".join(
            f"  - {s}" for s in skipped
        )

    msg.set_content(body)

    for p in to_attach:
        msg.add_attachment(
            p.read_bytes(),
            maintype="application",
            subtype="octet-stream",
            filename=p.name,
        )

    with smtplib.SMTP(host, port, timeout=60) as smtp:
        smtp.starttls()
        smtp.login(username, password)
        refused = smtp.send_message(msg)

    if refused:
        print(f"Some recipients refused: {refused}", file=sys.stderr)
        return 1

    print(f"Sent to {', '.join(recipients)} ({len(to_attach)} attachments)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
