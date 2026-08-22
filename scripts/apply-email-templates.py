"""Push the email templates in supabase/email-templates/ to the live project.

Kept as a script rather than a one-off paste into the dashboard so the templates live in the
repository, can be diffed, and can be re-applied to another project without hand-copying HTML.
"""
import json, io, os, sys, urllib.request, urllib.error

REF = "zinhzpgprhhqmyxmchhm"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEMPLATES = {
    "confirm-signup.html": ("mailer_templates_confirmation_content",
                            "mailer_subjects_confirmation", "Confirm your email"),
    "magic-link.html":     ("mailer_templates_magic_link_content",
                            "mailer_subjects_magic_link", "Your sign-in code"),
    "reset-password.html": ("mailer_templates_recovery_content",
                            "mailer_subjects_recovery", "Reset your password"),
    "change-email.html":   ("mailer_templates_email_change_content",
                            "mailer_subjects_email_change", "Confirm your new email"),
}


def env(name):
    for line in io.open(os.path.join(HERE, ".env.local"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def main():
    token = env("SUPABASE_ACCESS_TOKEN")
    if not token:
        sys.exit("SUPABASE_ACCESS_TOKEN missing from .env.local")

    payload = {}
    for filename, (content_key, subject_key, subject) in TEMPLATES.items():
        path = os.path.join(HERE, "supabase", "email-templates", filename)
        payload[content_key] = io.open(path, encoding="utf-8").read()
        payload[subject_key] = subject

    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{REF}/config/auth",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "User-Agent": "curl/8.4.0",
                 "Content-Type": "application/json", "Accept": "*/*"},
        method="PATCH")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
        for filename in TEMPLATES:
            print("applied", filename)
    except urllib.error.HTTPError as e:
        sys.exit(f"failed: {e.code} {e.read().decode()[:500]}")


if __name__ == "__main__":
    main()
