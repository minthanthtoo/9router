# Automatic deployment

Push to `master` → official patch replay → regression tests → Docker build and rehearsal → deploy
when repository variable `AUTO_DEPLOY=true`. The production branch is the release
boundary: local commits and feature-branch pushes do not deploy.
For a deliberate release while auto-deploy is paused, use **Run workflow**,
selecting `master` and enabling **deploy**.
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

   The key submits the full fork commit, image size, official base commit, receiver
   checksum and compressed-image SHA-256, followed by the CI image stream. The
   receiver hashes the stream while loading it and verifies source/revision/base
   labels. Docker image IDs are not portable across Engine versions. Install the
   checked receiver before releasing this workflow. An incompatible receiver or
   different image is rejected before cutover.
4. In the GitHub `production` environment set secrets `DEPLOY_SSH_KEY` and
   `DEPLOY_KNOWN_HOSTS` using the verified host key. Set `DEPLOY_HOST` to the host.
   Restrict the environment to `master`. No manual reviewer is needed for auto-deploy.
5. Set repository variable `AUTO_DEPLOY=true` for checked master-push deployments.
   Set it to `false` to pause automatic releases while retaining checks and manual deployment.

## Preserved state and recovery

GitHub Actions verifies the official tag in `patches/upstream.json`, replays the
committed patch series, runs regressions, builds the image and rehearses two
cutovers on isolated Docker with synthetic data. Only requested master releases
upload an image and transfer checksum. The host streams the checked image into
Docker and records the fork SHA, image ID and official base. A host lock
serializes deployments and superseded branch commits are rejected.
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
Never restore an old database over newly accepted work.

## Release storage and backups

- The receiver budgets 2 GiB for local CI state including completed and failed
  snapshots and interrupted scratch files. It checks the next data copy against
  that budget and plans space for rehearsal, backup and staged restore. Docker's
  filesystem needs a 3 GiB reserve plus estimated import headroom. Low space
  defers the release before the service stops. Data growth during migration can
  use part of the reserve.
- After a healthy cutover, keep five stopped, verified rollback containers.
  Legacy names identify the incoming commit, so the receiver matches the outgoing
  image against an earlier successful receipt. New receipts record the previous
  container and image IDs. Unknown containers remain for review. Cleanup removes
  unused managed image tags and unmounted receiver rehearsal directories.
- Review candidates with `sudo python3 /opt/9router-render/ci/receive.py --retention-plan`.
  Use an approved private off-host archive mount on a separate filesystem. From
  the operator shell run
  `sudo python3 /opt/9router-render/ci/receive.py --archive-retired /path/to/mount`.
  The receiver checks the full member list, compares the files with the source,
  records a checksum in the local receipt, then removes the redundant local copy.
  Keep the mount restricted, apply the approved off-host retention policy, and
  periodically restore a sample into scratch space and check SQLite integrity.
  Failed or pending recovery snapshots require review.

Check deployment results under the GitHub Actions **Check and deploy** workflow.
Retry an idle-deferred deployment with **Run workflow** on `master`, enabling
**deploy**. Check free space and active work before retrying. Test requests, credit redemption and clearing
held image results are never part of deployment checks.

To change production branch/repository, update both `production.yml` and the
root-owned receiver constants together. Changes to the receiver require reinstalling
it on the host before releasing the exact matching commit. Save the previous
script, run the read-only retention plan, and install the checked script atomically
while holding the host deployment lock. Use the authorized operator SSH route.
