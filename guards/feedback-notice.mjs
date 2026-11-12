// Only exact, known setup notices are informational. Unknown bot feedback has
// the same wake priority as human feedback, including edits to these notices.
export const claudeSetupNotice = "## Claude Code Review\n\nThis repository is configured for manual code reviews. Comment `@claude review` for a one-time review, or `@claude review always` to subscribe this PR to a review on every future push.\n\n<sub>Tip: disable this comment in your organization's [Code Review settings](https://claude.ai/admin-settings/claude-code#code-review).</sub>";
export function isSetupNotice(row) {
  return (row.author ?? row.user?.login) === 'claude[bot]' &&
    (row.review_state ?? row.state) === 'COMMENTED' && String(row.body ?? '').trim() === claudeSetupNotice;
}
