# Released dependency provenance

This optional policy applies only when an instance user explicitly requires
a released-upstream -> existing automatic mirror sync -> consumer adoption path.
Configure dependency-policy.json using the empty example. Do not import another
instance's repository mapping or release authorization. A release request never
grants unrelated stable releases, deployments or external comments.

## Invalid delivery route

Normal workflow pr_ready, Slack PR delivery and merge gates reject targets in the
configured internal-fork repositories, including an already claimed action's
final review-send check. The existing automation owns synchronization; this
workflow observes its actual outcome instead of authoring/reopening a manual
backport PR. Do not work around this guard with direct CLI publication or a new
fork branch. Existing running work is preserved and existing cancelled receipts
are not replayed.

A tracked governed-fork PR produces `reconcile_release_route` after a current
state read. Closed-unmerged remains distinct from merged or delivered. Resolve
this lifecycle obligation with exact-event record_progress(ack=false), then
lifecycle_resolve(disposition=progress). Its saved goal must contain:

- goal.dependency_delivery = {upstream_repository, fork_repository,
  consumer_repository, required_commit}; required_commit is the original upstream
  fix commit, not the private backport.
- Four existing concrete stages annotated with release_step: upstream_release,
  automatic_fork_sync, consumer_adoption, integrated_acceptance. Each later stage
  depends on its predecessor, directly or transitively.

Annotate/reuse actual completed release/sync evidence and already running owners;
these labels are not new preparation rounds or permission to restart work. A
stage cannot wait for approval/merge of the invalid fork PR. After this concrete
successor is saved, the obsolete fork watch retires without completing its task.
This replaces an invalid route with authorized work, not a fresh generic blocker.

## Consumer adoption evidence

When technical review identifies a governed dependency/pin change, include
evidence.dependency_adoption in the existing review/merge preflight:

```json
{
  "consumer_repository": "configured/consumer",
  "consumer_head": "exact PR head",
  "dependencies": [{
    "upstream_repository": "configured/upstream",
    "fork_repository": "configured/mirror",
    "required_commit": "full original upstream fix SHA",
    "release": {
      "tag": "actual published tag", "commit": "actual release SHA",
      "published": true, "draft": false, "published_at": "actual ISO time",
      "contains_required_commit": true, "evidence_ref": "release and ancestry evidence"
    },
    "sync": {
      "method": "existing_automation", "result": "success", "run_id": "actual run ID",
      "upstream_tag": "same release tag", "upstream_commit": "same release SHA",
      "commit": "actual synchronized fork SHA", "evidence_ref": "run and source evidence"
    },
    "pin_commit": "same synchronized fork SHA"
  }]
}
```

The guard binds the consumer head, configured repositories, published release,
required-fix membership, automatic-sync identity and actual pinned commit. Tests
passing on a private cherry-pick do not satisfy this proof. Unrelated feature PRs
do not need a new dependency audit. Classification of pin-changing diffs and the
actual source reads remain the coordinator/technical review's responsibility;
this is a workflow check, not interception of arbitrary Git commands. A CI-only
exception does not authorize ordinary publication or a production pin.

The maintenance task does not publish a release, sync a fork, merge a PR or write
central task/Notion state. It queues the validated rule and incident evidence to
the coordinator, while original owners continue the actual product path.
