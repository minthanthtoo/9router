import PropTypes from 'prop-types';
import { getUpstreamUpdateNotice } from '../utils/upstreamUpdateNotice.mjs';

export default function UpstreamUpdateNotice({ latestVersion }) {
  const notice = getUpstreamUpdateNotice(latestVersion);
  if (!notice) return null;

  return (
    <section aria-label="Official update notice" className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2">
      <p className="text-xs font-semibold text-amber-500">{notice.title}</p>
      <p className="mt-1 text-[11px] text-text-muted">{notice.message}</p>
      <a href={notice.href} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
        View official release notes
        <span aria-hidden="true" className="material-symbols-outlined text-[13px]">open_in_new</span>
      </a>
    </section>
  );
}

UpstreamUpdateNotice.propTypes = { latestVersion: PropTypes.string };
