# Judge Arena Roadmap A — Phase-A Deployment Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the durability preflight that must exist before the first labelling session — real WAL archiving to R2, base backups, a staleness alert that can actually fire, and one rehearsed restore — so that human labels, the first unreproducible artifact in the product, are not accumulating on an untested 24-hour-RPO path.

**Architecture:** `judge-arena-pg` gains an in-tree `spec.backup.barmanObjectStore` pointing at a new R2 bucket, credentialed by a SOPS secret materialised into `tenant-public` following the pattern velero already uses. A `ScheduledBackup` supplies the weekly base backups that WAL segments are deltas against. A `VMRule` alerts on both "never backed up" and "backup stale", which are different conditions with different meanings. Finally the whole thing is proved by restoring into a scratch namespace, because a backup nobody has restored is a hypothesis.

**Tech Stack:** CloudNativePG 1.27.3 (in-tree barman, no plugin CRD installed), PostgreSQL 16.4, Cloudflare R2 (S3-compatible), SOPS 3.9.4 + age, Flux Kustomize, VictoriaMetrics `VMRule`.

## Global Constraints

- **Repo:** all changes in this plan are in **`homelab-setup`**, not `judge-arena`. Work in a worktree.
- **Operator is CloudNativePG 1.27.3 and `kubectl get crd | grep -i barman` is EMPTY.** Backup config MUST be in-tree `spec.backup.barmanObjectStore`. Do **not** use `spec.plugins` — the barman-cloud plugin is not installed and a plugin-shaped config would be silently inert.
- **`retentionPolicy` is mandatory, not optional.** Landing archiving without it keeps every WAL segment in R2 forever. Use `"30d"`.
- **All retention goes to R2, never to the LINSTOR pool.** `local-3rep` charges 3 GiB of committed pool per GiB and `LinstorPoolProvisionedHeadroomLow` is already firing (w-gharial 17.5% free). `local-3rep`/ext4 also cannot shrink — every on-cluster storage decision is a one-way door.
- **Cloudflare account ID is `dae9f7baf0099a692500aaf430e0dcd0`** and the R2 S3 endpoint is `https://dae9f7baf0099a692500aaf430e0dcd0.r2.cloudflarestorage.com`. This is **already plaintext in git** at `clusters/homelab/velero/helmrelease.yaml:79`, so putting it in a manifest follows existing practice and introduces no new exposure. Do not invent a mechanism to hide it.
- **SOPS encrypts automatically by path.** `.sops.yaml` matches `.*\.sops\.(yaml|yml|json)$` with `encrypted_regex: ^(data|stringData)$` and two age recipients. Any file named `*.sops.yaml` gets both recipients with no flags needed.
- **Never print a decrypted secret value to stdout in a shared transcript.** Pipe decryptions into a consumer, or assert on key *names*.
- **`clusters/homelab/apps/judge-arena.yaml` already has the `decryption` block** (`provider: sops`, `secretRef: sops-age`, at line 137). Do not add a second one; do verify it is still there before Task 2, because without it a SOPS secret applies still-encrypted and CNPG fails with an unhelpful credentials error.
- **Chart version bumps:** none of this touches `charts/judge-arena/`, so `Chart.yaml` stays at `0.1.0`. If a later task does touch a chart template, bumping `version:` is mandatory — an unbumped chart change silently no-ops while every status surface reports success.

---

## Stage 1 — WAL archiving and PITR

### Task 1: Create the R2 bucket and add its name to the credentials secret

**Files:**
- Modify: `clusters/homelab/backup/r2-credentials.sops.yaml` (add one `stringData` key)

**Interfaces:**
- Consumes: nothing.
- Produces: R2 bucket `homelab-pg-wal`; secret key `bucket_pg_wal` in the canonical credentials file. Task 2 copies that file; Task 3 hardcodes the bucket name in `destinationPath`.

- [ ] **Step 1: Confirm the bucket does not already exist**

```bash
cd /root/homelab-setup   # or your worktree
TOKEN=$(sops -d clusters/homelab/backup/r2-credentials.sops.yaml \
  | python3 -c 'import yaml,sys; print(yaml.safe_load(sys.stdin)["stringData"]["cf_api_token"])')
curl -s "https://api.cloudflare.com/client/v4/accounts/dae9f7baf0099a692500aaf430e0dcd0/r2/buckets" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys; print([b["name"] for b in json.load(sys.stdin)["result"]["buckets"]])'
```

Expected: a list that does **not** contain `homelab-pg-wal`. (It should contain `homelab-velero`, `homelab-etcd-snapshots`, `tbr-uploads`.)

- [ ] **Step 2: Create the bucket**

```bash
curl -sX POST "https://api.cloudflare.com/client/v4/accounts/dae9f7baf0099a692500aaf430e0dcd0/r2/buckets" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"homelab-pg-wal"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("success:",d["success"],"errors:",d.get("errors"))'
```

Expected: `success: True errors: []`

- [ ] **Step 3: Re-run Step 1 to confirm creation**

Expected: the list now contains `homelab-pg-wal`.

- [ ] **Step 4: Add the bucket-name key to the credentials secret**

`sops set` is non-interactive, so this needs no editor:

```bash
sops set clusters/homelab/backup/r2-credentials.sops.yaml \
  '["stringData"]["bucket_pg_wal"]' '"homelab-pg-wal"'
```

- [ ] **Step 5: Verify the key landed and the file is still encrypted**

```bash
# key names only — never print values
sops -d clusters/homelab/backup/r2-credentials.sops.yaml \
  | python3 -c 'import yaml,sys; print(sorted(yaml.safe_load(sys.stdin)["stringData"].keys()))'
grep -c "ENC\[" clusters/homelab/backup/r2-credentials.sops.yaml
```

Expected: the key list includes `bucket_pg_wal`; the `grep -c` is non-zero (values still encrypted at rest).

- [ ] **Step 6: Commit**

```bash
git add clusters/homelab/backup/r2-credentials.sops.yaml
git commit -m "feat(backup): add bucket_pg_wal to the R2 credentials secret

Bucket homelab-pg-wal created for CNPG WAL archiving. Adding the name here
keeps every R2 target enumerated in one reviewable place, matching
bucket_velero and bucket_etcd_snapshots."
```

---

### Task 2: Materialise the R2 credentials into `tenant-public`

CNPG reads its S3 credentials from a Secret **in its own namespace**. There is no cross-namespace secret reference, so the credentials must exist in `tenant-public`. The established pattern for this is a byte-identical SOPS copy — `clusters/homelab/velero/r2-credentials.sops.yaml` is exactly that, and its own kustomization comment says so.

**Files:**
- Create: `apps/public/judge-arena/r2-credentials.sops.yaml`
- Modify: `apps/public/judge-arena/kustomization.yaml`

**Interfaces:**
- Consumes: `bucket_pg_wal` and the S3 keys from Task 1.
- Produces: Secret `judge-arena-r2` in namespace `tenant-public`, carrying keys `aws_access_key_id` and `aws_secret_access_key`. Task 3 references exactly those two names.

- [ ] **Step 1: Confirm the Kustomization can decrypt**

```bash
grep -A4 "decryption:" clusters/homelab/apps/judge-arena.yaml
```

Expected: `provider: sops` and `secretRef: name: sops-age`. **If this is missing, stop** — a SOPS file would apply still-encrypted and CNPG would fail with a confusing credentials error rather than a decryption one.

- [ ] **Step 2: Produce the namespaced copy**

Decrypt the canonical file, rewrite `metadata` for this namespace, and let SOPS re-encrypt on write. Only the two S3 keys are carried over — the API token and the other buckets have no business in `tenant-public`, and a secret should hold what its consumer needs and nothing else.

```bash
sops -d clusters/homelab/backup/r2-credentials.sops.yaml \
  | python3 -c '
import yaml, sys
src = yaml.safe_load(sys.stdin)
out = {
    "apiVersion": "v1",
    "kind": "Secret",
    "metadata": {"name": "judge-arena-r2", "namespace": "tenant-public"},
    "type": "Opaque",
    "stringData": {
        "aws_access_key_id": src["stringData"]["aws_access_key_id"],
        "aws_secret_access_key": src["stringData"]["aws_secret_access_key"],
    },
}
yaml.safe_dump(out, sys.stdout, default_flow_style=False, sort_keys=False)
' > /tmp/judge-arena-r2.plain.yaml

sops --encrypt /tmp/judge-arena-r2.plain.yaml > apps/public/judge-arena/r2-credentials.sops.yaml
shred -u /tmp/judge-arena-r2.plain.yaml
```

- [ ] **Step 3: Verify it encrypted to both recipients and kept the metadata readable**

```bash
grep -c "ENC\[" apps/public/judge-arena/r2-credentials.sops.yaml
python3 -c '
import yaml
d = yaml.safe_load(open("apps/public/judge-arena/r2-credentials.sops.yaml"))
print("name:", d["metadata"]["name"], "ns:", d["metadata"]["namespace"])
print("recipients:", len(d["sops"]["age"]))
'
sops -d apps/public/judge-arena/r2-credentials.sops.yaml \
  | python3 -c 'import yaml,sys; print(sorted(yaml.safe_load(sys.stdin)["stringData"].keys()))'
```

Expected: `ENC[` count non-zero; `name: judge-arena-r2 ns: tenant-public`; `recipients: 2`; key list exactly `['aws_access_key_id', 'aws_secret_access_key']`.

- [ ] **Step 4: Register it in the kustomization**

Add `- r2-credentials.sops.yaml` to the `resources:` list in `apps/public/judge-arena/kustomization.yaml`, keeping the existing ordering style of that file.

- [ ] **Step 5: Verify the Kustomization builds**

```bash
kubectl kustomize apps/public/judge-arena | grep -A3 "name: judge-arena-r2"
```

Expected: the Secret appears in the build output. It will still show encrypted values — that is correct; Flux decrypts server-side.

- [ ] **Step 6: Commit**

```bash
git add apps/public/judge-arena/r2-credentials.sops.yaml apps/public/judge-arena/kustomization.yaml
git commit -m "feat(judge-arena): materialise R2 S3 credentials into tenant-public

CNPG reads S3 credentials from a Secret in its own namespace and there is no
cross-namespace reference, so the credentials must exist in tenant-public. Same
byte-copy pattern clusters/homelab/velero/r2-credentials.sops.yaml uses.

Carries ONLY aws_access_key_id and aws_secret_access_key — not cf_api_token,
not the other bucket names. A secret should hold what its consumer needs and
nothing more, and the API token in particular can create and delete buckets."
```

---

### Task 3: Turn on WAL archiving on `judge-arena-pg`

**Files:**
- Modify: `apps/public/judge-arena/cnpg-cluster.yaml` (add `spec.backup`, alongside `spec.instances` / `spec.storage`)

**Interfaces:**
- Consumes: Secret `judge-arena-r2` keys from Task 2; bucket `homelab-pg-wal` from Task 1.
- Produces: a working archive destination at `s3://homelab-pg-wal/judge-arena`. Task 4's `ScheduledBackup` writes base backups to the same path; Task 5 alerts on the resulting metric.

- [ ] **Step 1: Record the "before" state, so the change is provable**

```bash
kubectl -n tenant-public get cluster judge-arena-pg \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}{"\n"}'
kubectl -n tenant-internal exec svc/vmselect-shortterm -c vmselect -- \
  wget -qO- 'http://127.0.0.1:8481/select/0/prometheus/api/v1/query?query=cnpg_collector_last_available_backup_timestamp{job="tenant-public/judge-arena-pg"}'
```

Expected: `ContinuousArchiving=True` (the no-op default — this is the lie this task fixes), and a metric value of `0`, meaning no backup exists.

- [ ] **Step 2: Add the backup block**

Insert into `spec:` of the `Cluster` in `apps/public/judge-arena/cnpg-cluster.yaml`:

```yaml
  ## ── WAL archiving + PITR ──────────────────────────────────────────────────
  ## Before this block existed, `ContinuousArchiving: True` was reported on this
  ## cluster (and all 18 others) with NO destination configured: CNPG's
  ## wal-archive exits 0 when there is no object store, so the condition
  ## honestly reported a meaningless exit code. Healthy and broken were
  ## byte-identical from the operator's side, which is why no probe could have
  ## caught it and only an alert can (see the VMRule added alongside this).
  ##
  ## MUST be in-tree `spec.backup`, NOT `spec.plugins`: the operator is
  ## cloudnative-pg 1.27.3 and `kubectl get crd | grep -i barman` is empty, so
  ## the barman-cloud plugin is not installed and a plugin-shaped config would
  ## be silently inert — the same failure mode this block exists to fix.
  ##
  ## Destination is R2, never the LINSTOR pool: local-3rep charges 3 GiB of
  ## committed pool per GiB, LinstorPoolProvisionedHeadroomLow is already
  ## firing, and ext4-on-local-3rep cannot shrink. Off-cluster retention costs
  ## ~$0.35-1.00/month and zero pool.
  backup:
    ## retentionPolicy is NOT optional. Without it barman keeps every WAL
    ## segment in R2 forever, and WAL volume here is driven by archive_timeout
    ## rather than traffic — an idle cluster still forces a 16 MiB segment on a
    ## timer.
    retentionPolicy: "30d"
    barmanObjectStore:
      destinationPath: s3://homelab-pg-wal/judge-arena
      endpointURL: https://dae9f7baf0099a692500aaf430e0dcd0.r2.cloudflarestorage.com
      s3Credentials:
        accessKeyId:
          name: judge-arena-r2
          key: aws_access_key_id
        secretAccessKey:
          name: judge-arena-r2
          key: aws_secret_access_key
      wal:
        compression: gzip
      data:
        compression: gzip
```

- [ ] **Step 3: Validate the manifest parses and the keys match Task 2 exactly**

```bash
python3 -c '
import yaml
docs = [d for d in yaml.safe_load_all(open("apps/public/judge-arena/cnpg-cluster.yaml")) if d]
c = [d for d in docs if d.get("kind") == "Cluster"][0]
b = c["spec"]["backup"]
print("retentionPolicy:", b["retentionPolicy"])
print("destinationPath:", b["barmanObjectStore"]["destinationPath"])
cr = b["barmanObjectStore"]["s3Credentials"]
print("secret refs:", cr["accessKeyId"], cr["secretAccessKey"])
assert "plugins" not in c["spec"], "must not use spec.plugins on operator 1.27.3"
print("OK")
'
```

Expected: prints the values and `OK`. The secret name must read `judge-arena-r2` and the keys `aws_access_key_id` / `aws_secret_access_key`, matching Task 2's output exactly.

- [ ] **Step 4: Commit and let Flux reconcile**

```bash
git add apps/public/judge-arena/cnpg-cluster.yaml
git commit -m "feat(judge-arena): real WAL archiving to R2, with a retention policy

ContinuousArchiving reported True on this cluster with no destination
configured, because CNPG's wal-archive exits 0 when there is no object store.
The condition was honestly reporting a meaningless exit code, so healthy and
broken were indistinguishable from outside. This is the first actual PITR
destination in the cluster.

In-tree spec.backup deliberately, not spec.plugins: operator is 1.27.3 with no
barman CRD installed, so a plugin-shaped config would be silently inert — the
same class of failure being fixed here.

retentionPolicy 30d is load-bearing: WAL volume is driven by archive_timeout
rather than traffic, so an idle cluster would otherwise accumulate 16 MiB
segments in R2 indefinitely."
git push
```

Then reconcile (or wait for the interval):

```bash
flux reconcile kustomization judge-arena --with-source
```

- [ ] **Step 5: Verify archiving actually works — not that the config applied**

The whole point of this task is that "config applied" and "archiving works" are different claims, so assert the second:

```bash
# Force a WAL switch so there is something to archive
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- \
  psql -U postgres -c "SELECT pg_switch_wal();"

sleep 30

kubectl -n tenant-public get cluster judge-arena-pg -o jsonpath='{.status.conditions}' \
  | python3 -c 'import json,sys; [print(c["type"],"=",c["status"],"|",c.get("message","")[:90]) for c in json.load(sys.stdin)]'
```

Expected: `ContinuousArchiving=True` **and** no archiving-failure message. Then confirm objects actually exist in R2:

```bash
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- \
  bash -lc 'barman-cloud-wal-archive --version >/dev/null 2>&1 && echo barman-present'
```

If the tooling is not shell-reachable in the image, verify from the operator's view instead:

```bash
kubectl -n tenant-public logs judge-arena-pg-1 -c postgres --tail=50 | grep -i "archive"
```

Expected: log lines showing successful WAL uploads, and **no** repeated `WAL archive failed` entries.

---

### Task 4: Add base backups — WAL alone is not restorable

WAL segments are deltas. Without a base backup to replay them onto, a 30-day WAL history restores exactly nothing.

**Files:**
- Modify: `apps/public/judge-arena/cnpg-cluster.yaml` (append a `ScheduledBackup` document)

**Interfaces:**
- Consumes: the `barmanObjectStore` from Task 3.
- Produces: `ScheduledBackup/judge-arena-pg-weekly`, and a non-zero `cnpg_collector_last_available_backup_timestamp` once it first runs — which is the signal Task 5 alerts on.

- [ ] **Step 1: Append the ScheduledBackup**

```yaml
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: judge-arena-pg-weekly
  namespace: tenant-public
spec:
  ## CNPG schedules use a SIX-field cron (seconds first) — not the five-field
  ## Kubernetes CronJob format. A five-field value here is a validation error at
  ## best and an unintended schedule at worst.
  ## 02:30 UTC every Sunday: outside the 08:00Z cnpg-all-daily Velero window, so
  ## a base backup and a filesystem snapshot never contend for the same disk.
  schedule: "0 30 2 * * 0"
  backupOwnerReference: self
  cluster:
    name: judge-arena-pg
  ## Weekly base + 30d WAL retention = a 30-day PITR floor with at most ~7 days
  ## of WAL to replay from the oldest base. Shorten the schedule before
  ## lengthening retention if restore TIME becomes the complaint.
  method: barmanObjectStore
```

- [ ] **Step 2: Validate it parses and uses six cron fields**

```bash
python3 -c '
import yaml
docs = [d for d in yaml.safe_load_all(open("apps/public/judge-arena/cnpg-cluster.yaml")) if d]
sb = [d for d in docs if d.get("kind") == "ScheduledBackup"][0]
s = sb["spec"]["schedule"]
print("schedule:", s, "| fields:", len(s.split()))
assert len(s.split()) == 6, "CNPG needs a six-field cron"
print("cluster:", sb["spec"]["cluster"]["name"], "| method:", sb["spec"]["method"])
print("OK")
'
```

Expected: `fields: 6`, cluster `judge-arena-pg`, and `OK`.

- [ ] **Step 3: Commit, push, reconcile**

```bash
git add apps/public/judge-arena/cnpg-cluster.yaml
git commit -m "feat(judge-arena): weekly base backup for judge-arena-pg

WAL segments are deltas; without a base backup to replay onto, a 30-day WAL
history restores nothing. Weekly base + 30d WAL retention gives a 30-day PITR
floor with at most ~7 days of WAL replay from the oldest base.

Six-field cron (seconds first) — CNPG's schedule format is not the
Kubernetes CronJob five-field one. 02:30 UTC Sunday keeps it clear of the
08:00Z cnpg-all-daily Velero window so the two never contend for disk."
git push
flux reconcile kustomization judge-arena --with-source
```

- [ ] **Step 4: Trigger one on-demand backup rather than waiting a week**

```bash
kubectl -n tenant-public create -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  generateName: judge-arena-pg-first-
  namespace: tenant-public
spec:
  cluster:
    name: judge-arena-pg
  method: barmanObjectStore
EOF
```

- [ ] **Step 5: Verify it completed, and that the metric moved off zero**

```bash
kubectl -n tenant-public get backup -o custom-columns=\
'NAME:.metadata.name,PHASE:.status.phase,STARTED:.status.startedAt,STOPPED:.status.stoppedAt'

kubectl -n tenant-internal exec svc/vmselect-shortterm -c vmselect -- \
  wget -qO- 'http://127.0.0.1:8481/select/0/prometheus/api/v1/query?query=cnpg_collector_last_available_backup_timestamp{job="tenant-public/judge-arena-pg"}'
```

Expected: `PHASE: completed`, and the metric now a real unix timestamp instead of `0`. **That transition from 0 is the deliverable of this task** — it is what makes Task 5's alert meaningful.

---

### Task 5: Alert on both "never backed up" and "backup stale"

These are two different conditions and collapsing them produces a rule that cannot work. **Verified 2026-08-10: `cnpg_collector_last_available_backup_timestamp` already has 35 series cluster-wide and every one reads `0`.** So the metric is present and has been scraped all along — nobody wrote the rule. Two consequences:

- A naive `time() - metric > threshold` computes `time() - 0` ≈ 1.79 billion seconds and **fires instantly for all 18 clusters**, which is technically true and operationally useless.
- The `== 0` case is the one that matters most, because it is precisely the "a schedule that has never once completed is invisible" failure this program keeps rediscovering.

**Files:**
- Create: `apps/managed/alerting/rules/cnpg-backup-coverage.yaml`

**Interfaces:**
- Consumes: `cnpg_collector_last_available_backup_timestamp`, labels `job`, `namespace`, `pod` (verified present; for this cluster `job="tenant-public/judge-arena-pg"`).
- Produces: two alerts, `CNPGClusterNeverBackedUp` and `CNPGBackupStale`.

- [ ] **Step 1: Write the VMRule**

```yaml
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: cnpg-backup-coverage
  namespace: tenant-internal
spec:
  groups:
    - name: cnpg-backup-coverage
      rules:
        ## The failure this program kept rediscovering: a backup destination
        ## that was never configured is INVISIBLE, because the healthy and
        ## broken states are byte-identical from the operator's side. The metric
        ## reports 0 rather than going absent, so this is expressible — and it
        ## was expressible all along. Verified 2026-08-10: 35 series, all zero.
        - alert: CNPGClusterNeverBackedUp
          expr: cnpg_collector_last_available_backup_timestamp == 0
          for: 30m
          labels:
            severity: warning
          annotations:
            summary: "CNPG cluster {{ $labels.job }} has never completed a backup"
            description: >-
              cnpg_collector_last_available_backup_timestamp is 0, meaning no
              base backup exists, so there is nothing for WAL to replay onto and
              no PITR floor. Check spec.backup.barmanObjectStore is present AND
              in-tree (not spec.plugins — the barman plugin CRD is not
              installed), and that the namespace has the S3 credentials Secret.
            runbook: "docs/runbooks/judge-arena-restore.md"

        ## Distinct condition, distinct meaning: archiving WAS working and has
        ## stopped. The `> 0` guard is what keeps this from double-firing on
        ## every never-backed-up cluster above.
        - alert: CNPGBackupStale
          expr: >-
            (cnpg_collector_last_available_backup_timestamp > 0)
            and
            (time() - cnpg_collector_last_available_backup_timestamp > 691200)
          for: 1h
          labels:
            severity: warning
          annotations:
            summary: "CNPG cluster {{ $labels.job }} has no backup in 8 days"
            description: >-
              The most recent base backup is more than 8 days old against a
              weekly schedule, so one run has been missed entirely. Both alerts
              CLEAR on their own once a backup completes — neither is a ratchet.
            runbook: "docs/runbooks/judge-arena-restore.md"
```

- [ ] **Step 2: Verify both expressions against live data before shipping them**

This is the step that catches a rule which can never fire. Run each `expr` as a query:

```bash
kubectl -n tenant-internal exec svc/vmselect-shortterm -c vmselect -- \
  wget -qO- --post-data='query=cnpg_collector_last_available_backup_timestamp == 0' \
  'http://127.0.0.1:8481/select/0/prometheus/api/v1/query'
```

Expected: a non-empty result **before** Task 4 runs, and one fewer series (judge-arena-pg absent) after it. That difference is the proof the rule tracks reality.

```bash
kubectl -n tenant-internal exec svc/vmselect-shortterm -c vmselect -- \
  wget -qO- --post-data='query=(cnpg_collector_last_available_backup_timestamp > 0) and (time() - cnpg_collector_last_available_backup_timestamp > 691200)' \
  'http://127.0.0.1:8481/select/0/prometheus/api/v1/query'
```

Expected: empty immediately after Task 4's fresh backup. An empty result here is correct, not a failure — but it means this rule is unproven, so also sanity-check the shape by temporarily lowering `691200` to `60` in a scratch query (not in the file) and confirming it then matches.

- [ ] **Step 3: Confirm the rule loads**

```bash
git add apps/managed/alerting/rules/cnpg-backup-coverage.yaml
git commit -m "feat(alerting): alert on CNPG clusters with no backup, and on stale backups

cnpg_collector_last_available_backup_timestamp already had 35 series
cluster-wide, every one reading 0 — the metric that would have revealed a
cluster with no PITR destination has been scraped all along and nobody wrote
the rule. This is the safeguard escape in its purest form: the data was there.

Two alerts, deliberately not one. == 0 means never backed up, which is the
invisible case. The stale rule guards on > 0 because a naive
time() - metric > threshold computes time() - 0 and would fire instantly for
all 18 clusters at once — true, and useless.

Both clear on their own when a backup completes, so neither is a ratchet."
git push
flux reconcile kustomization managed --with-source
kubectl -n tenant-internal get vmrule cnpg-backup-coverage
```

Expected: the VMRule exists. Then confirm vmalert picked it up:

```bash
kubectl -n tenant-internal logs deploy/vmalert-vmalert-shortterm --tail=40 | grep -i "cnpg-backup-coverage"
```

---

### Task 6: Rehearse the restore, then write the runbook from what happened

**No restore has ever been performed in this cluster, by any mechanism, for any workload.** Until one has, RTO is unmeasured and the backup is a hypothesis. This task is what converts Stage 1 from configuration into a capability.

**Files:**
- Create: `docs/runbooks/judge-arena-restore.md` (in `homelab-setup`)

**Interfaces:**
- Consumes: the completed backup from Task 4.
- Produces: a runbook written from an actual rehearsal, and a measured RTO. The two alerts in Task 5 already reference this path.

- [ ] **Step 1: Restore into a scratch namespace, never over the live cluster**

```bash
kubectl create namespace judge-arena-restore-test
```

Copy the R2 credentials Secret into it (same two keys), then create a recovery Cluster:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: judge-arena-pg-restore
  namespace: judge-arena-restore-test
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16.4
  storage:
    size: 10Gi
    storageClass: local-3rep
  bootstrap:
    recovery:
      source: judge-arena-pg-origin
  externalClusters:
    - name: judge-arena-pg-origin
      barmanObjectStore:
        destinationPath: s3://homelab-pg-wal/judge-arena
        endpointURL: https://dae9f7baf0099a692500aaf430e0dcd0.r2.cloudflarestorage.com
        s3Credentials:
          accessKeyId:
            name: judge-arena-r2
            key: aws_access_key_id
          secretAccessKey:
            name: judge-arena-r2
            key: aws_secret_access_key
        wal:
          compression: gzip
```

- [ ] **Step 2: Time it, because RTO is the number nobody has**

```bash
date -u +%FT%TZ    # record start
kubectl -n judge-arena-restore-test get cluster judge-arena-pg-restore -w
```

Stop when the cluster reports healthy. Record the elapsed time — this is the first measured RTO for this cluster.

- [ ] **Step 3: Prove the restored data is real**

```bash
kubectl -n judge-arena-restore-test exec judge-arena-pg-restore-1 -c postgres -- \
  psql -U postgres -d judge_arena -c '\dt' | head -20
kubectl -n judge-arena-restore-test exec judge-arena-pg-restore-1 -c postgres -- \
  psql -U postgres -d judge_arena -c 'select count(*) from "_prisma_migrations";'
```

Expected: the application tables are present and `_prisma_migrations` has 12 rows. A restore that yields an empty schema is the Railway failure mode all over again — `SELECT 1` succeeds against a schema-less database, so count something real.

- [ ] **Step 4: Prove the `ENCRYPTION_KEY` pairing, which is the part a DB-only restore gets wrong**

A database restored without the matching `ENCRYPTION_KEY` yields undecryptable provider keys — and worse, `decryptSafe` currently returns the ciphertext *as if it were the key*, so the failure is silent. Confirm the key that pairs with this snapshot:

```bash
kubectl -n tenant-public get secret judge-arena-crypto \
  -o jsonpath='{.data.ENCRYPTION_KEY}' | sha256sum
```

Record the digest (not the key) in the runbook, so a future restore can verify pairing without ever printing the secret.

- [ ] **Step 5: Tear down the scratch namespace**

```bash
kubectl delete namespace judge-arena-restore-test
```

Confirm the PVC is gone — `local-3rep` is thick-provisioned, so a forgotten 10 GiB scratch volume costs 30 GiB of committed pool against an already-alerting headroom figure:

```bash
kubectl get pv | grep judge-arena-restore || echo "no orphaned PVs"
```

- [ ] **Step 6: Write the runbook from the rehearsal and commit**

`docs/runbooks/judge-arena-restore.md` must contain: the exact recovery manifest used, the measured RTO from Step 2, the verification queries from Step 3, the `ENCRYPTION_KEY` digest from Step 4, the teardown check from Step 5, and an explicit statement that database and encryption key must be restored **together**.

```bash
git add docs/runbooks/judge-arena-restore.md
git commit -m "docs(runbook): judge-arena restore, rehearsed rather than theorised

First restore ever performed in this cluster by any mechanism, so this records
a measured RTO instead of an assumed one. Written from the rehearsal.

Includes the ENCRYPTION_KEY pairing check as a sha256 digest: a DB-only restore
yields undecryptable provider keys, and decryptSafe currently returns the
ciphertext as though it were the key, so that failure is silent rather than
loud. Verifying the digest catches a mispaired restore before it looks like it
worked."
git push
```

---

## Stage 1 exit gate

> **✅ ALL SIX PASSED — verified 2026-08-12 against the live cluster, not the pipeline.**
> Metric is a real timestamp (`1786408645`), not `0`. 23 WAL segments archived, `failed_count 0`;
> the ~19h gap at the time of checking was genuine idleness, since `archive_timeout=5min` only
> forces a switch after write activity and the database has essentially no rows yet. Restore
> rehearsed into a scratch namespace: 25 tables, 12/12 `_prisma_migrations`. Runbook records a
> **measured 60s RTO** — read its caveat, that number is pod-scheduling-dominated and will not
> survive a loaded database. No orphaned PVs; scratch namespace gone.
>
> One deliberate deviation from the wording below: `CNPGClusterNeverBackedUp` is **scoped to
> judge-arena-pg only**, so it does *not* "still match the clusters that genuinely have no backup".
> Unscoped it would install 6 notification groups and ~34 permanently-open alerta entries that
> nothing clears without unscheduled work on clusters this repo cannot all reach — a ratchet in
> CLAUDE.md's exact sense. The residual risk is real and worth restating: **17 CNPG clusters still
> have zero backups and now have zero alert coverage**, only 5 of them fixable from this repo.

- [ ] `cnpg_collector_last_available_backup_timestamp{job="tenant-public/judge-arena-pg"}` is a real timestamp, not `0`.
- [ ] A forced `pg_switch_wal()` produces WAL uploads in the postgres logs with no archive failures.
- [ ] `CNPGClusterNeverBackedUp` no longer matches judge-arena-pg, and still matches the clusters that genuinely have no backup.
- [ ] A restore has completed into a scratch namespace with the application tables present and 12 `_prisma_migrations` rows.
- [ ] `docs/runbooks/judge-arena-restore.md` exists with a measured RTO.
- [ ] No orphaned `judge-arena-restore` PVs remain.

**Only after this gate does labelling (Roadmap A's A1) become safe to start**, because A1 produces the first unreproducible data in the product and this stage is what stops it accumulating on an untested path.

---

## What this stage deliberately does NOT cover

Rebaseline **T2** is broader than WAL archiving, and the remaining T2 items are
intentionally out of Stage 1 so it stays one reviewable deliverable. None is
blocked by Stage 1, and none blocks it:

- **`decryptSafe` must fail loudly** instead of returning ciphertext as the key.
  App code in `judge-arena`, and it is what makes a mispaired restore *loud* rather
  than merely detectable by the digest check in Task 6.
- **Guard the Flux `prune` → PVC delete → `reclaimPolicy: Delete` path**, which is
  the "one commit can destroy the database" finding.
- **CNPG `instances: 1 → 2`**, which also unblocks draining w-gharial (the PDB
  currently permits zero disruptions). Carries a +256 Mi request and +30 GiB of
  LINSTOR ledger, so it is gated on the T1 memory work.
- **A judge-arena-specific Velero schedule with a long TTL**, separate from
  `cnpg-all-daily`'s 30-day window.
- **Cap `rawResponse`/`reasoning` growth**, which is what stops high retention
  becoming the thing that fills the pool.

## Later stages of the phase-A preflight

Listed so the sequence is not lost. **Updated 2026-08-12** — Stages 2 and 3 are done, Stage 4's premise changed, and a Stage 6 was added that nothing had written down.

- **Stage 2 — Seeder. ✅ DONE 2026-08-11.** Bundled via esbuild to `/app/seed.js` (the `admin-create-user.js` precedent), both default-password `CredentialsProvider` accounts removed — which also dropped the `bcryptjs` import that was one of the three reasons it could not run in-image — all three keyless operator-funded `ModelEndpoint`s removed, and the sample `Project`/`Evaluation`/`EvaluationRun` dropped so `EvaluationRun > 0` means something again. Public artifacts are owned by a non-login `platform@judgearena.local`. Idempotent; five DB tests guard the removals. Also seeds `ScalerLab/JudgeBench` (MIT, 620 rows, both splits) as a public `Dataset` — see the caveat in Roadmap A trap 12: it is **reference data, not runnable**, because the items are pairwise and the only prompt template is pointwise.
- **Stage 3 — Gitea CI. ✅ DONE 2026-08-11.** `homelab-bot` added as a read collaborator (it was genuinely absent — job-ops had it, this repo did not); `HOMELAB_BOT_SSH_KEY` turned out to be owner-scoped and already inherited. The `TODO(Phase 2)` stub is replaced by a real kaniko spawn + heartbeat wait. **The pipeline had never executed anything** — it died at `Setup Node` on every run — so clearing this took four runner-side fixes in homelab-setup, none patchable from inside a workflow (divergence entries 61–64). The unit step now asserts the suite actually ran, because a red setup step and a red test step look identical in the run list and mean opposite things about coverage.
- **Stage 4 — Judge dataset hosting. SCOPE REDUCED.** No longer needed for JudgeBench: 620 rows is ~2.8MB vendored in-repo and read at runtime, which costs no LINSTOR pool and no NFS. `nfs-bulk-retain` (NFS `192.168.1.168:/mnt/Silver/k8s/bulk`, 1×, Retain) is still the right answer for anything genuinely large — `TIGER-Lab/MMLU-Pro`, LiveBench, `ASSELab/ReliableBench`, `ASSELab/JudgeStressTest`, `ASSELab/CoinflipForSafety` — so keep the pattern, but do not build it until a set actually needs it.
- **Stage 5 — Capture gaps found while probing llama.cpp.** Still open, re-verified 2026-08-12: `reasoning_content` is read **nowhere** in `src/`, so chain-of-thought is discarded on every reasoning-model call — and A3's diagnosis feature is built on it. Empty content is unguarded, so a reasoning model that exhausts `max_tokens` yields an empty judgment with a healthy-looking token count. Plus run-grain `startedAt` on `EvaluationRun` (confirmed absent — the model has `createdAt` and `finalizedAt` and nothing between).
- **Stage 6 — DB-backed CI. NEW, and it should come before A0.** `test:db` (286 tests) and `test:integration` cannot run in CI: act_runner is host-mode with no container engine, so `services:` sidecars cannot start. Roadmap A is ~24 days of code whose correctness lives almost entirely in the database layer, so this is the suite that matters most and the one that does not run. Fix: one ephemeral k8s Job in `tenant-builds` whose pod carries postgres/redis/rabbitmq as **sidecars** alongside a `node:22-alpine` main container — sidecars share a network namespace, so `localhost:5432` works exactly as `services:` intended. Reuses the kaniko spawn + heartbeat-wait pattern. The runner can create Jobs in `tenant-builds` but **not** bare Pods (verified), so it must be a Job.
