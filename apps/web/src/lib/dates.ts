/**
 * Format an ISO date string into a human-readable format.
 *
 * Examples:
 *   formatDate("2026-08-19T00:00:00.000Z") => "Aug 19, 2026"
 *   formatDate("2026-08-19T14:30:00.000Z") => "Aug 19, 2026 2:30 PM"
 *   formatDate(null) => "—"
 */
export function formatDate(
  iso: string | null | undefined,
  opts?: { includeTime?: boolean },
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';

  const date = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  if (opts?.includeTime) {
    const time = d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `${date}, ${time}`;
  }

  return date;
}

/**
 * Format as relative time ("5 min ago", "2 hours ago", etc.)
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';

  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(months / 12);
  return `${years}y ago`;
}
