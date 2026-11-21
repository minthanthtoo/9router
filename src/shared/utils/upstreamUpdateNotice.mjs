export function getUpstreamUpdateNotice(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  return {
    title: `Upstream package v${version} available`,
    message: 'Compatibility with this patched fork has not been verified. Review before updating.',
    href: 'https://github.com/decolua/9router/releases',
  };
}
