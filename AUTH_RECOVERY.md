# Cloud authentication recovery

Yang explicitly authorized computer use to complete AWS login for already
authorized work, proactive monitoring/coaching of authentication failures, and
retaining verified lessons in memory. Source: setup chat
01a197ae-904e-7310-a36c-77adc9ecbb5c, 2026-11-02. Authentication is a recoverable
task stage, not task completion, cancellation, or a reason to abandon the goal.

## Diagnose before opening a browser

- Read the actual failed operation, host, execution environment, profile/session,
  account/role/region and timestamp. Preserve the job/VM/worktree/checkpoint and
  original scope. Recheck a historic error before treating it as current.
- Test the same credential chain used by the task with a bounded read-only
  identity request, e.g. `aws sts get-caller-identity --profile <profile>`.
  Verify expected account/role without logging credential material. A successful
  request may refresh credentials automatically; no browser login is then needed.
- Classify: expired/unrefreshable authentication, credential-source mismatch,
  browser/device/callback failure, authorization denial, network/TLS failure,
  resource/quota/capacity error, or unknown. AccessDenied with a valid identity is
  not evidence that another login fixes missing permission. Never enlarge IAM
  permissions or bypass TLS/MFA as an authentication workaround.
- Inspect only profile metadata and presence/source of environment overrides.
  Never print credential files, access/refresh/session tokens, passwords, auth
  codes or full debug logs. Do not globally unset/change environment variables.
  Local CLI success does not prove a remote SDK/process with separately injected
  short-lived credentials is repaired; validate in the original environment.

## One owner per login session

The original blocked execution owner owns recovery for its authorized work.
Discovery and maintenance coach that owner when it cannot complete a supported
flow; they do not leave the task waiting for Yang to perform routine sign-in.
Main may perform a shared recovery when Yang directly requests it. No retired
coordinator, new service, task or heartbeat is required.

Track recovery keyed by host + provider + actual SSO/login session (not just
profile, since profiles can share a session), with one recovery owner,
affected tasks, attempt generation, sanitized error, stage and next check.
Record a lease before interactive recovery. Check for an existing owned login
process/browser tab first; reuse the live flow. An expired challenge must not be
reused. Do not start simultaneous browser logins or interfere with another
agent's active tab/native focus. Never kill arbitrary login/browser processes.

Prefer the installed provider CLI's supported flow. Read the profile type first:

- IAM Identity Center (`sso_session`/SSO metadata): `aws sso login --profile ...`.
  Use `--no-browser` to open its exact URL explicitly in external Chrome. PKCE
  needs the browser on the same machine as the CLI. For a remote/headless CLI or
  a verified callback-routing problem, supported `--use-device-code --no-browser`
  avoids that same-device callback requirement. Keep the polling CLI alive.
- `login_session` console-login profile: use its supported `aws login` flow;
  check installed help/docs for `--remote` when needed. Do not convert an SSO
  profile to console login or rewrite unrelated configuration to work around it.
- Role/instance/workload-identity or credential_process: diagnose that configured
  chain; do not replace it with unrelated credentials or a new browser identity.

Use the user's external browser only, preferably external Chrome integration
and supported Bitwarden autofill. Any available company or personal profile is
allowed; confirm the resulting AWS account/role matches the original task.
The vm-manager skill's older company-profile-only wording is narrower than
Yang's explicit instruction and does not require asking again. Use supported UI
tools; do not extract passwords/cookies/tokens from browser storage.

Complete ordinary navigation, account selection and login consent within the
authorized flow. Pause the dependent authentication step for biometric, passkey,
hardware key, CAPTCHA, push MFA or another genuinely human-only factor. Put one
precise request in the decision inbox with the browser/location and exact action.
Preserve the task, continue independent work and resume automatically once the
factor is completed and access reverified. Do not repeatedly ask Yang to perform
the whole login when computer use was already authorized.

After success, require CLI completion/exit success, a matching STS identity and
the previously failed read-only provider call where practical. Then resume only
the authorized next step. Before any cloud mutation, reconcile live resources
and the VM registry to avoid duplicating creation after an ambiguous failure.
Never restart a healthy benchmark, steal a VM lease, or erase checkpoints for
authentication recovery. Preserve existing human holds and resource capacity.

## Monitoring, coaching and learning

At each original-owner continuation and existing discovery/maintenance health
audit, check new authentication failures and unresolved shared recoveries before
accepting another unchanged access wait. Scan actual recent task outcomes/errors, not the
entire history on every run. Start recovery only after a current failure or a
genuine due operation establishes need; do not repeatedly log in to healthy
profiles. A queued task with valid credentials can still be waiting for resources.

If the blocked owner is idle, send one scoped recovery instruction with the
exact classification and next diagnostic/flow. If it already owns a running
login, observe or coordinate a necessary corrective step; do not send generic
continue/restart messages. An already-authorized recovery owner may complete browser login
while the execution worker preserves its task. All affected tasks share the
single recovered session; dispatch resumption once per task and auth generation.

After two failed attempts with no new evidence, stop repeating the same flow,
inspect the concrete failure and try an evidence-based alternative or raise the
specific human-only blocker. Keep retryable task state; never mark the task done,
archive it, create a duplicate task, or restart the underlying job merely because
login failed. Idle/time elapsed is not proof of authentication recovery.

Keep sanitized incidents in existing task checkpoints and durable observations
under the workflow instance; do not revive the retired registry/coordinator:
profile/session type, owner, stage, evidence, attempted fix, result, resumed step,
and prevention. Deduplicate incidents by affected session and failure generation.
Do not persist ephemeral authorization URLs, one-time codes or credential blobs.

Do not write local memory merely because authentication failed. Preserve the
sanitized reusable procedure here; local memory changes require a current
explicit user request. Do not record passwords, tokens or one-time URLs/codes.

## Required ordinary recovery before a human request

An expired token, blank page, missing automatic fill, or a stale tab is a
recoverable stage, not by itself a human-only blocker. Before recording an AWS
access wait, read this runbook and save a concise checkpoint containing the
actual profile/session and execution host, current identity result, active login
owner/process, attempted supported UI steps and the exact remaining obstacle.
Reuse matching verified successes below. Do not rerun a known failed approach
without a changed input.

For the external Chrome + Bitwarden flow:

1. Keep one fresh provider CLI login alive. If the old polling process ended or
   its challenge expired, start one fresh challenge, not another concurrent flow.
2. Select the actual AWS tab. After an AWS redirect, a detached/previous-page
   accessibility capture is not evidence that sign-in failed. Use Chrome's
   native accessibility UI, select the observed tab and inspect the current page.
   If necessary replace only the broken login tab with the current CLI challenge.
3. Click the visible Bitwarden toolbar/inline control. When the vault is unlocked
   and the matching AWS entry exists, explicitly choose its Fill action. Waiting
   for passive autofill is insufficient. On a multi-step sign-in, fill the
   username, advance, then invoke Fill again for the password. Never reveal or
   copy the secret into tool output, code, logs or chat.
4. Complete ordinary sign-in/consent within the existing access scope. A locked
   vault may itself need human unlock; a visible passkey/biometric/hardware key,
   CAPTCHA or push-MFA is a concrete human step. Ask only for that step after
   saving the current flow, not for the whole login or a password in chat.
5. Require CLI exit success and correct account/role identity. Then reverify the
   failed read in the worker's actual environment, including injected guest
   credentials where relevant. Shared SSO success is not proof that an old
   remote process has refreshed its credentials.
6. Resume each affected original owner once using saved source/checkpoints.
   Preserve successful benchmark cells, active jobs, task holds and least
   privilege. Do not rerun completed work or change IAM just to repair sign-in.

The existing discovery/maintenance audit must not classify "autofill did not
provide credentials" as verified human-only without the explicit Fill attempt
and visible vault/step result. If an owner lacks working browser capabilities,
coach or perform that bounded recovery in the existing capable workflow role;
do not make Yang the default substitute operator. Failed/inconclusive capability
checks remain honest blockers, with the attempted fallback and smallest human
action recorded. No unsupported App UI/RPC or secret extraction is permitted.

## Evidence checked on 2026-11-02

- Build-cache rollout recovery: default credentials returned InvalidClientTokenId;
  the intended devland SSO profile separately returned expired/unrefreshable token.
  A command-scoped environment cleanup did not repair either credential source.
  Standard `aws sso login --profile devland --no-browser` plus external Chrome
  and Bitwarden autofill succeeded after the user completed the passkey step.
  CLI exit zero, matching account 054483968661 STS, and the original EC2 read were
  independently verified. Do not confuse a valid browser session with valid CLI
  credentials or switch accounts to conceal a profile failure.
- During that login, browser-tab DOM/accessibility capture became detached across
  the AWS redirect. Chrome's native accessibility UI, selecting the observed AWS
  tab and then refreshing state, recovered the flow. Use this supported fallback
  after a stale/detached tab check; do not loop the same failed CDP snapshot or
  change MFA/security settings. Passkey steps still require the human boundary.
  Sanitized evidence: build-acceleration/aws-final-verification.json.

- Local AWS CLI is 2.39.1. The devland profile has sso_session/account/role metadata
  and is an IAM Identity Center profile, not a login_session profile.
- A fresh read-only STS request using devland succeeded at 2026-11-01 17:07:26 UTC.
  No login was started because no current authentication failure was reproduced.
- FTS S3 recovery audit recorded `TokenRetrievalError; no login initiated`:
  /Users/yang/src/codex-workspace/lance/outputs/fts-nvme-s3/s3-worker-tuning-20261030/recovery-audit-20261101.json.
  This is a workflow gap, not proof the browser cannot authenticate.
- Earlier FTS S3 history (thread 01a16da7-152b-7a23-bd6c-1394ad9519ae,
  turn 01a18d29-fccd-7de0-89fb-85aeb24552a3) recorded one expired device challenge
  followed by a fresh external-Chrome flow that succeeded. Its notes also reported
  concurrent native focus changes; this is a possible interference factor, not
  a confirmed sole root cause. Never reuse the expired challenge or its code.
- The same history recorded later automatic SSO token refresh succeeding without
  another human sign-in. Historical expiry is not a standing login requirement.

Official references:
- https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html
- https://docs.aws.amazon.com/cli/latest/reference/sso/login.html
- https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html

## Verified recovery on 2026-11-09

T-027 and T-190 had stopped on expired devland SSO. The old polling CLI was no
longer active. One fresh local PKCE CLI flow was opened in external Chrome.
AWS redirect accessibility became detached/blank; selecting a fresh login tab
through Chrome's native UI and explicitly opening Bitwarden exposed the form.
The unlocked vault contained the matching AWS entry. Explicit Fill was needed
on the username page and again on the password page. Sign-in then completed
without any human factor in this attempt. CLI exited successfully and fresh STS
verified account 054483968661 and the configured AdministratorAccess role.

This demonstrates an ordinary supported recovery on this host, not a guarantee
that future MFA can be automated. Do not infer guest credentials are refreshed;
the original workers still verify their own exact reads. Sanitized instance
evidence: observations/aws-auth-recovery-20261109/result.json.
