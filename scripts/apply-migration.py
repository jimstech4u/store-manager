"""Apply one migration file to the live project, through the Management API.

Kept as a script for the same reason the email templates are: the SQL lives in the repository and
gets applied from there, rather than being pasted into a dashboard where nobody can diff it
afterwards or replay it onto a second project.

    python scripts/apply-migration.py supabase/migrations/0048_staff_identity_and_permissions.sql

It prints what it is about to run and stops on the first error. There is no rollback — Postgres
runs each statement in its own implicit transaction here — so migrations are written to be
re-runnable: `add column if not exists`, `create or replace`, `create table if not exists`.
"""
import io, json, os, sys, urllib.error, urllib.request

REF = "zinhzpgprhhqmyxmchhm"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env(name):
    for line in io.open(os.path.join(HERE, ".env.local"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def run_sql(token, sql):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/%s/database/query" % REF,
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={
            "Authorization": "Bearer %s" % token,
            "Content-Type": "application/json",
            # Cloudflare in front of the Management API rejects urllib's default agent with a
            # 403/1010. The email-template script hit the same wall and settled on this.
            "User-Agent": "curl/8.4.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8") or "[]")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    token = env("SUPABASE_ACCESS_TOKEN")
    if not token:
        print("SUPABASE_ACCESS_TOKEN is not in .env.local")
        return 1

    path = sys.argv[1]
    sql = io.open(os.path.join(HERE, path), encoding="utf-8").read()
    print("applying %s (%d bytes)" % (path, len(sql)))

    try:
        result = run_sql(token, sql)
        print("OK")
        if result:
            print(json.dumps(result)[:400])
        return 0
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        print("FAILED %s" % e.code)
        print(body[:2000])
        return 1


if __name__ == "__main__":
    sys.exit(main())
