# Verified absence of hosted CI

An empty check list alone never authorizes Ready or delivery. For the narrow
verified-absence case, applicable_ci may use mode=verified_no_hosted_ci with an
empty checks array. This means CI is not applicable, not that CI passed.
Ordinary nonempty-check behavior and all native publication permissions remain.

The normal PR/head-before/head-after, freshness, complete, phase, evidence_ref
and policy_ref fields remain required. Also attach local_validation with the
exact head_sha, passed=true and a real evidence_ref for matching local validation.
Reusing valid same-head evidence is allowed; a log path alone is not a pass.

no_hosted_ci binds repository, pr_number, head_sha, checked_at, evidence_ref and
complete=true. Its base_ref/base_ref_before/base_ref_after must match, and
base_before/base_after must be one exact SHA. Every provider surface must be
successfully and completely read: check_runs/statuses/workflows each records
complete=true,count=0; workflow_files records complete=true and empty head/base
file lists; branch_policy records complete=true, protected=false and empty
effective_rules. This initial narrow contract supports an unprotected target
with no effective branch rules. Protected, rule-bearing or unknown cases do not
receive an automatic waiver; never loosen repository rules to enter this path.

Use fetch-no-ci-policy.mjs --repo owner/repo --pr NUMBER --output evidence.json
with phase=pre_ready or pre_delivery. It reads paginated provider checks/statuses,
Actions inventory, effective base-branch rules, and immutable head/base Git trees.
It verifies the PR/base/protection/rules again and records freshness from the
start of collection. Read errors, inconsistent refs or nonempty/unknown policy
fail closed. It does not assert local validation or modify the repository.

Attach the actual local_validation separately. For lifecycle observation, use
its truthful snapshot plus the completed applicable_ci evidence. No synthetic
passing check is inserted. Refresh before prepare, claim and final send; the
normal sixty-second operation freshness limit remains. A changed head/base or
newly observed check requires new evidence. Nonempty checks conflict with the
absence mode, including successful, failed and pending checks.

First Ready does not require the Gatekeeper review it triggers. Canonical URL
delivery still requires the actual current-head verified Gatekeeper verdict and
independent all-author semantic feedback disposition. Xuanwo approval, current
repository rules/required checks and expected-head merge remain separate gates.
This contract neither fabricates approval nor grants a merge/CI-policy bypass.
