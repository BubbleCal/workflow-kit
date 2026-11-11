// A user-facing title is presentation only. Never use its prefix as a ledger
// identity, ownership key, or authorization.
export function displayTaskTitle(task, fallback) {
  const title=task?.data?.title?.trim()||fallback||task?.id||'';
  if (/^(?:PM|T)-\d{3,}\s*·\s*\S/i.test(title)) return title;
  const reference=task?.data?.public_reference??task?.id;
  return reference&&reference!==title?`${reference} · ${title}`:title;
}
