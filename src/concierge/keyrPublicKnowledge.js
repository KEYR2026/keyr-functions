const KEYR_PUBLIC_KNOWLEDGE = [
  {
    id: 'keyr_overview',
    title: 'What is KEYR?',
    content: 'KEYR is a financial technology company focused on helping people build a stronger financial foundation through guided credit-building, debt-reduction support, and education.'
  },
  {
    id: 'keyr_mission',
    title: 'KEYR mission',
    content: 'KEYR is focused on financial advancement, positive habit development, and helping people build healthier financial patterns over time.'
  },
  {
    id: 'keyr_founder',
    title: 'Founder',
    content: 'KEYR was founded by a public-interest-minded entrepreneur rooted in Oklahoma.'
  },
  {
    id: 'keyr_location',
    title: 'Business location',
    content: 'KEYR is based in Oklahoma, with roots in Oklahoma City and Edmond.'
  },
  {
    id: 'keyr_oklahoma_roots',
    title: 'Oklahoma roots',
    content: 'KEYR has Oklahoma roots and is grounded in community, education, and practical financial progress.'
  },
  {
    id: 'anchor_overview',
    title: 'Anchor',
    content: 'Anchor is KEYR\'s secured credit-building product designed to support responsible credit-building habits and a practical path toward financial progress.'
  },
  {
    id: 'ascend_overview',
    title: 'Ascend',
    content: 'Ascend is an unsecured KEYR product designed for people who may be ready for a broader credit-building and debt-reduction path with a structured approach.'
  },
  {
    id: 'apex_overview',
    title: 'Apex',
    content: 'Apex is KEYR\'s premium unsecured product designed for a more advanced stage of the financial journey, subject to eligibility, approval, and applicable program terms.'
  },
  {
    id: 'safe_start_overview',
    title: 'Safe Start',
    content: 'Safe Start is an optional readiness experience. It is not a card, not an account, not an application result, and not a fourth product or guaranteed progression stage.'
  },
  {
    id: 'autopay_advantage',
    title: 'AutoPay Advantage',
    content: 'AutoPay Advantage is a public program feature intended to support consistent, on-time payment habits and guided financial responsibility.'
  },
  {
    id: 'balance_transfer_overview',
    title: 'Balance-transfer overview',
    content: 'Balance-transfer features may be available only where approved and subject to applicable eligibility, approval, credit limits, product availability, and program terms.'
  },
  {
    id: 'anchor_reporting_policy',
    title: 'Anchor positive-only reporting policy',
    content: 'Anchor follows a positive-only reporting policy for the account and related activity, with program and reporting terms subject to the applicable account disclosures.'
  },
  {
    id: 'responsible_progression',
    title: 'Responsible progression',
    content: 'Progression is never guaranteed. Product eligibility, approval, underwriting, product availability, and final account terms remain subject to program requirements and disclosures.'
  },
  {
    id: 'pricing_overview',
    title: 'Pricing',
    content: 'KEYR provides public pricing information to help visitors understand the products and journey options available, subject to program terms and final account disclosures.'
  },
  {
    id: 'how_it_works',
    title: 'How it works',
    content: 'KEYR helps people understand how its products, education tools, and guided pathways can support responsible financial improvement over time.'
  },
  {
    id: 'education_overview',
    title: 'Education',
    content: 'KEYR emphasizes education, practical guidance, and positive habit development as part of the customer experience.'
  },
  {
    id: 'application_process',
    title: 'Application process',
    content: 'KEYR applications are subject to verification, eligibility requirements, approval, underwriting, product availability, and applicable program terms.'
  },
  {
    id: 'contact_process',
    title: 'Contact process',
    content: 'The public website offers navigation, FAQs, and contact pathways for questions that require additional support or human follow-up.'
  },
  {
    id: 'public_website_pages',
    title: 'Public website pages',
    content: 'Public website content includes navigation to Explore, Pricing, FAQs, Education, How It Works, Apply, and Contact pages.'
  },
  {
    id: 'public_agent_limits',
    title: 'Public-agent limits',
    content: 'Public website guidance is limited to general information and cannot access personal account data, determine eligibility, or provide personalized financial recommendations.'
  },
  {
    id: 'financial_coach_distinction',
    title: 'Financial Coach distinction',
    content: 'The KEYR Financial Coach is a separate experience designed to provide additional guidance and support to members. KEYR Concierge focuses on general public information and website navigation.'
  },
  {
    id: 'current_product_availability',
    title: 'Current product availability',
    content: 'Current active products are Anchor, Ascend, and Apex, subject to product availability and applicable program terms.'
  },
  {
    id: 'launch_and_program_status',
    title: 'Launch and program status',
    content: 'Public product and program information may evolve with launches, product availability, and updated disclosures.'
  }
];

const PRODUCT_DEFINITIONS = {
  Anchor: {
    id: 'anchor_overview',
    short: 'Anchor is KEYR\'s secured credit-building product designed to support responsible credit-building habits.',
    comparison: 'Anchor is a secured product intended for credit-building and structured progress.'
  },
  Ascend: {
    id: 'ascend_overview',
    short: 'Ascend is an unsecured KEYR product designed for people who may be ready for a broader credit-building path.',
    comparison: 'Ascend is an unsecured product designed for practical credit-building and debt-management support.'
  },
  Apex: {
    id: 'apex_overview',
    short: 'Apex is KEYR\'s premium unsecured product designed for a more advanced stage of the financial journey.',
    comparison: 'Apex is a higher-stage unsecured product designed for more advanced progression.',
  },
  'Safe Start': {
    id: 'safe_start_overview',
    short: 'Safe Start is an optional readiness experience, not a card, not an account, and not a guaranteed product stage.',
    comparison: 'Safe Start is a readiness experience, not a card or guaranteed product path.'
  }
};

function getPublicKnowledge() {
  return [...KEYR_PUBLIC_KNOWLEDGE];
}

function findKnowledgeById(ids = []) {
  const idsSet = new Set((ids || []).filter(Boolean));
  return KEYR_PUBLIC_KNOWLEDGE.filter((entry) => idsSet.has(entry.id));
}

function getApprovedProductOverview(name) {
  const normalized = String(name || '').trim();
  if (!normalized) {
    return null;
  }

  const direct = PRODUCT_DEFINITIONS[normalized] || PRODUCT_DEFINITIONS[normalized.toLowerCase()];
  if (direct) {
    return direct;
  }

  const candidate = Object.keys(PRODUCT_DEFINITIONS).find((product) => product.toLowerCase() === normalized.toLowerCase());
  return candidate ? PRODUCT_DEFINITIONS[candidate] : null;
}

module.exports = {
  KEYR_PUBLIC_KNOWLEDGE,
  PRODUCT_DEFINITIONS,
  getPublicKnowledge,
  findKnowledgeById,
  getApprovedProductOverview
};
