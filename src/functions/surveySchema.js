const DEFAULT_SURVEY_VERSION = '2026.09';
const SUPPORTED_SURVEY_VERSIONS = ['2026.09', '2026.10'];

const V2026_10_ALLOWED = {
  primary_outcomes: [
    'reduce_high_interest_debt',
    'debt_free_sooner',
    'lower_monthly_payments',
    'rebuild_credit',
    'build_first_credit',
    'better_credit_terms',
    'learn_credit_management',
    'exploring_options'
  ],
  debt_duration: [
    'none',
    'under_3_months',
    '3_6_months',
    '7_12_months',
    'over_1_year',
    'over_3_years',
    'prefer_not_to_answer'
  ],
  card_situation: [
    'multiple_balances',
    'one_balance',
    'sometimes_carry',
    'pay_in_full',
    'building_rebuilding',
    'no_card'
  ],
  baseline_apply_intent_90d: ['definitely', 'probably', 'might', 'probably_not', 'definitely_not'],
  approach_choice: ['traditional_rewards', 'keyr_financial_progress', 'need_more_info', 'neither'],
  outcome_apply_intent: ['very_likely', 'somewhat_likely', 'review_estimate_first', 'somewhat_unlikely', 'very_unlikely', 'no_eligible_debt'],
  top_conversion_driver: ['interest_savings', 'debt_free_sooner_same_payment', 'lower_apr', 'low_transfer_fee', 'savings_exceed_fee', 'none'],
  fee_acceptance: ['definitely_worthwhile', 'probably_worthwhile', 'depends_on_net_savings', 'probably_not_worthwhile', 'definitely_not_worthwhile', 'no_annual_fee_cards'],
  next_step: ['apply_immediately', 'join_pilot', 'review_terms_then_consider', 'compare_options', 'request_more_info', 'probably_not_apply'],
  early_access_interest: ['yes', 'maybe', 'no']
};

function resolveSurveyVersion(input) {
  if (input === null || input === undefined || String(input).trim() === '') {
    return DEFAULT_SURVEY_VERSION;
  }

  const normalized = String(input).trim();
  if (SUPPORTED_SURVEY_VERSIONS.includes(normalized)) {
    return normalized;
  }

  return null;
}

function isAllowedValue(value, allowedValues) {
  return typeof value === 'string' && allowedValues.includes(value);
}

function validateV2026_10Responses({ responses, cleanString, cleanArray, validateEmail }) {
  const validationErrors = [];

  const primaryOutcomes = cleanArray(responses.primary_outcomes, 100);
  const uniquePrimaryOutcomes = Array.from(new Set(primaryOutcomes));

  if (primaryOutcomes.length < 1 || primaryOutcomes.length > 2 || uniquePrimaryOutcomes.length !== primaryOutcomes.length) {
    validationErrors.push('primary_outcomes must contain 1-2 unique values.');
  }

  if (!uniquePrimaryOutcomes.every((value) => isAllowedValue(value, V2026_10_ALLOWED.primary_outcomes))) {
    validationErrors.push('primary_outcomes contains invalid values.');
  }

  const debtDuration = cleanString(responses.debt_duration, 100);
  if (!isAllowedValue(debtDuration, V2026_10_ALLOWED.debt_duration)) {
    validationErrors.push('debt_duration is invalid.');
  }

  const cardSituation = cleanString(responses.card_situation, 100);
  if (!isAllowedValue(cardSituation, V2026_10_ALLOWED.card_situation)) {
    validationErrors.push('card_situation is invalid.');
  }

  const baselineApplyIntent90d = cleanString(responses.baseline_apply_intent_90d, 100);
  if (!isAllowedValue(baselineApplyIntent90d, V2026_10_ALLOWED.baseline_apply_intent_90d)) {
    validationErrors.push('baseline_apply_intent_90d is invalid.');
  }

  const approachChoice = cleanString(responses.approach_choice, 100);
  if (!isAllowedValue(approachChoice, V2026_10_ALLOWED.approach_choice)) {
    validationErrors.push('approach_choice is invalid.');
  }

  const outcomeApplyIntent = cleanString(responses.outcome_apply_intent, 100);
  if (!isAllowedValue(outcomeApplyIntent, V2026_10_ALLOWED.outcome_apply_intent)) {
    validationErrors.push('outcome_apply_intent is invalid.');
  }

  const topConversionDriver = cleanString(responses.top_conversion_driver, 100);
  if (!isAllowedValue(topConversionDriver, V2026_10_ALLOWED.top_conversion_driver)) {
    validationErrors.push('top_conversion_driver is invalid.');
  }

  const feeAcceptance = cleanString(responses.fee_acceptance, 100);
  if (!isAllowedValue(feeAcceptance, V2026_10_ALLOWED.fee_acceptance)) {
    validationErrors.push('fee_acceptance is invalid.');
  }

  const nextStep = cleanString(responses.next_step, 100);
  if (!isAllowedValue(nextStep, V2026_10_ALLOWED.next_step)) {
    validationErrors.push('next_step is invalid.');
  }

  const earlyAccessInterest = cleanString(responses.early_access_interest, 100);
  if (!isAllowedValue(earlyAccessInterest, V2026_10_ALLOWED.early_access_interest)) {
    validationErrors.push('early_access_interest is invalid.');
  }

  const rawEmail = cleanString(responses.email, 320);
  const emailRequired = earlyAccessInterest === 'yes' || earlyAccessInterest === 'maybe';
  let normalizedEmail = null;

  if (emailRequired) {
    if (!rawEmail || !validateEmail(rawEmail)) {
      validationErrors.push('email is required and must be valid for yes/maybe contact preference.');
    } else {
      normalizedEmail = rawEmail;
    }
  } else if (earlyAccessInterest === 'no') {
    normalizedEmail = null;
  }

  const openFeedback = cleanString(responses.open_feedback, 1000);

  return {
    ok: validationErrors.length === 0,
    validationErrors,
    normalizedResponses: {
      primary_outcomes: uniquePrimaryOutcomes,
      debt_duration: debtDuration,
      card_situation: cardSituation,
      baseline_apply_intent_90d: baselineApplyIntent90d,
      approach_choice: approachChoice,
      outcome_apply_intent: outcomeApplyIntent,
      top_conversion_driver: topConversionDriver,
      fee_acceptance: feeAcceptance,
      next_step: nextStep,
      early_access_interest: earlyAccessInterest,
      email: normalizedEmail,
      open_feedback: openFeedback
    }
  };
}

module.exports = {
  DEFAULT_SURVEY_VERSION,
  SUPPORTED_SURVEY_VERSIONS,
  V2026_10_ALLOWED,
  resolveSurveyVersion,
  validateV2026_10Responses
};
