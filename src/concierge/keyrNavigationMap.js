const NAVIGATION_ALLOWLIST = [
  { label: 'Home', routeId: 'home', url: '/' },
  { label: 'Explore Products', routeId: 'explore', url: '/explore.html' },
  { label: 'Pricing', routeId: 'pricing', url: '/pricing.html' },
  { label: 'FAQ', routeId: 'faq', url: '/faq.html' },
  { label: 'Education', routeId: 'education', url: '/education.html' },
  { label: 'How It Works', routeId: 'how_it_works', url: '/how-it-works.html' },
  { label: 'Apply', routeId: 'apply', url: '/apply.html' },
  { label: 'Contact', routeId: 'contact', url: '/contact.html' },
  { label: 'Debt Reduction Calculator', routeId: 'debt_reduction_calculator', url: '/debt-reduction-calculator.html' },
  { label: 'Privacy Policy', routeId: 'privacy', url: '/privacy.html' },
  { label: 'Terms of Use', routeId: 'terms', url: '/terms.html' },
  { label: 'Security', routeId: 'security', url: '/security.html' },
  { label: 'Safe Start', routeId: 'safe_start', url: '/safe-start.html' }
];

const NAVIGATION_BY_ROUTE = Object.fromEntries(NAVIGATION_ALLOWLIST.map((item) => [item.routeId, item]));
const ALLOWED_ROUTE_IDS = new Set(NAVIGATION_ALLOWLIST.map((item) => item.routeId));

function resolveRoute(routeId) {
  return NAVIGATION_BY_ROUTE[routeId] || null;
}

function isAllowedRoute(routeId) {
  return Boolean(routeId && ALLOWED_ROUTE_IDS.has(routeId));
}

module.exports = {
  NAVIGATION_ALLOWLIST,
  NAVIGATION_BY_ROUTE,
  ALLOWED_ROUTE_IDS,
  resolveRoute,
  isAllowedRoute
};
