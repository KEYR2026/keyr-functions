const COMPETITOR_PROFILES = [
  {
    companyName: 'Chime',
    reviewedDate: '2026-10-05',
    officialSourceUrls: ['https://www.chime.com/'],
    approvedFacts: [
      'Chime is a fintech company that offers debit-card and banking-related products, not a traditional credit-card product model.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Product structure', 'Credit-building focus', 'Pricing structure'],
    prohibitedClaims: ['KEYR is better', 'Chime penalizes people', 'Unsupported APRs', 'Unsupported fees'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Discover',
    reviewedDate: '2026-10-05',
    officialSourceUrls: ['https://www.discover.com/'],
    approvedFacts: [
      'Discover offers mainstream credit card products with different product structures and pricing approaches.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Product structure', 'Rewards structure', 'Current availability'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported rewards', 'Unsupported approval requirements'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Capital One',
    reviewedDate: '2026-10-05',
    officialSourceUrls: ['https://www.capitalone.com/'],
    approvedFacts: [
      'Capital One offers a range of credit card products and banking products with different product structures.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Product structure', 'Secured versus unsecured', 'Current availability'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported fees', 'Legal conclusions'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'JPMorgan Chase',
    reviewedDate: '2026-10-05',
    officialSourceUrls: ['https://www.chase.com/'],
    approvedFacts: [
      'Chase offers a range of consumer credit products and banking products with different structures.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Product structure', 'Current availability', 'Pricing structure'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported fees', 'Legal conclusions'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Bank of America',
    reviewedDate: '2026-10-05',
    officialSourceUrls: ['https://www.bankofamerica.com/'],
    approvedFacts: [
      'Bank of America offers credit cards and banking services with different structures and customer goals.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Product structure', 'Pricing structure', 'Current availability'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported rewards', 'Unverified approval outcomes'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'American Express',
    reviewedDate: '2026-10-05',
    officialSourceUrls: ['https://www.americanexpress.com/'],
    approvedFacts: [
      'American Express offers a set of credit card products with different attributes and customer needs.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Product structure', 'Rewards structure', 'Current availability'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported fees', 'Unsupported approval requirements'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Traditional secured credit cards',
    reviewedDate: '2026-10-05',
    officialSourceUrls: [],
    approvedFacts: [
      'Traditional secured cards are structurally different from KEYR\'s Anchor product and may serve credit-building needs differently.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Secured versus unsecured', 'Credit-building focus', 'Product structure'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported fees', 'Guaranteed credit improvement'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Traditional unsecured credit cards',
    reviewedDate: '2026-10-05',
    officialSourceUrls: [],
    approvedFacts: [
      'Traditional unsecured credit cards are generally structured differently than KEYR products and may have different approval requirements.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Secured versus unsecured', 'Approval requirements', 'Product structure'],
    prohibitedClaims: ['KEYR is better', 'Unsupported APRs', 'Unsupported approval promises', 'Unsupported fees'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Rewards cards',
    reviewedDate: '2026-10-05',
    officialSourceUrls: [],
    approvedFacts: [
      'Rewards products are designed with different features and customer goals than KEYR\'s credit-building and debt-reduction focus.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Pricing structure', 'Product structure', 'Credit-building focus'],
    prohibitedClaims: ['KEYR is better', 'Unsupported rewards', 'Unsupported APRs', 'Unsupported approval outcomes'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  },
  {
    companyName: 'Credit-builder products',
    reviewedDate: '2026-10-05',
    officialSourceUrls: [],
    approvedFacts: [
      'Credit-builder products may focus on building credit habits and reporting, while KEYR has distinct public product pathways and educational support.',
      'Different products are designed for different needs.'
    ],
    comparisonCategories: ['Credit-building focus', 'Product structure', 'Responsible progression'],
    prohibitedClaims: ['KEYR is better', 'Guaranteed credit improvement', 'Unsupported reporting claims', 'Unsupported legal conclusions'],
    freshnessStatus: 'current',
    reviewOrExpirationDate: '2026-12-31'
  }
];

function getCompetitorProfile(companyName) {
  const normalized = String(companyName || '').trim();
  if (!normalized) {
    return null;
  }

  const directMatch = COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === normalized.toLowerCase());
  if (directMatch) {
    return directMatch;
  }

  const alias = normalized.toLowerCase();
  if (alias.includes('chime')) {
    return COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === 'chime');
  }
  if (alias.includes('discover')) {
    return COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === 'discover');
  }
  if (alias.includes('capital one') || alias.includes('capitalone')) {
    return COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === 'capital one');
  }
  if (alias.includes('chase') || alias.includes('jpmorgan')) {
    return COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === 'jpmorgan chase');
  }
  if (alias.includes('bank of america') || alias.includes('bofa')) {
    return COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === 'bank of america');
  }
  if (alias.includes('amex') || alias.includes('american express')) {
    return COMPETITOR_PROFILES.find((profile) => profile.companyName.toLowerCase() === 'american express');
  }
  return null;
}

function isCompetitorFresh(profile) {
  if (!profile) {
    return false;
  }
  const expiry = profile.reviewOrExpirationDate ? new Date(profile.reviewOrExpirationDate) : new Date('1970-01-01');
  const now = new Date();
  return expiry.getTime() >= now.getTime();
}

module.exports = {
  COMPETITOR_PROFILES,
  getCompetitorProfile,
  isCompetitorFresh
};
