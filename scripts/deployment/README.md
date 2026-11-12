# Automatic deployment

Push to `master` → regression tests → Docker build → isolated health check.
Release through **Run workflow**, selecting `master` and enabling **deploy**.
Local commits do not trigger GitHub Actions. Pull requests and master pushes run
checks. Feature-branch pushes are checked through their pull request.
Pull requests run checks without server access. This workflow is limited to
`minthanthtoo/9router`; it cannot deploy from an upstream fork or another branch.

## One-time setup

1. Update `master` to the intended patched source before enabling deployment.
   The remote service may contain patches newer than the current fork.
2. Install `receive.py` as root-owned, non-writable by other users at
   `/opt/9router-render/ci/receive.py` on the existing Docker host.
3. Create a dedicated SSH key. Add its public key to root's `authorized_keys` with:

   ```text
   restrict,command="/usr/bin/python3 /opt/9router-render/ci/receive.py" ssh-ed25519 PUBLIC_KEY
   ```

   The key can only submit a full commit SHA and stream a checked Docker image;
   it cannot open a shell, forward ports, or copy arbitrary files.
4. In the GitHub `production` environment set secrets `DEPLOY_SSH_KEY` and
   `DEPLOY_KNOWN_HOSTS` using the verified host key. Set `DEPLOY_HOST` to the host.
   Restrict the environment to `master`. No manual reviewer is needed for auto-deploy.
5. Keep repository variable `AUTO_DEPLOY=false` for deliberate releases.
   Setting it to `true` opts back into deployment on each master push.

## Preserved state and recovery

The host receives the image built and checked by CI, identified by commit SHA.
A host lock serializes deployments and superseded branch commits are rejected.
Accounts, environment values, data mounts, network and restart policy come from the
running container, not GitHub. No production secrets are packaged in the image.

An isolated copy of the live SQLite database must survive candidate startup and
migration without losing existing values. Active image requests/tests defer the
release. At cutover the stopped database and files are backed up. The candidate
starts without network access and must pass health/auth and data-preservation checks.
Only then is it attached to the serving network.

Before network attachment, failure restores the old container and its data backup.
After attachment may have admitted requests, failure preserves current data and
creates `ci/pending.json`; another deployment is blocked until recovery is reviewed.
Never restore an old database over newly accepted work. The previous container,
backup and per-release `result.json` are retained for recovery. No automatic pruning
of serving images or backups is performed; low disk space stops image loading.

Check deployment results under the GitHub Actions **Check and deploy** workflow.
Retry an idle-deferred deployment with **Run workflow** on `master`, enabling
**deploy**. Check free space and active work before retrying. Test requests, credit redemption and clearing
held image results are never part of deployment checks.

To change production branch/repository, update both `production.yml` and the
root-owned receiver constants together. Changes to the receiver require reinstalling
it on the host; the CI key cannot change its own deployment restrictions.
