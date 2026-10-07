interface AnalystEvaluationCase {
  id: string;
  questions: string[];
  reviewCriteria: string[];
}

// Human review compares claims with returned SQL and rows. Keyword checks cannot
// establish whether a model's explanation is analytically correct.
export const analystEvaluationCases: AnalystEvaluationCase[] = [
  {
    id: "checkout-chart-meaning",
    questions: [
      "Give me a charted overview of the ordered checkout journey in December 2020.",
      "Where did sessions stop progressing most between those steps? Show the percentages clearly.",
      "Compare those step-to-step percentages with January 2021 in a chart.",
      "Explain what this means using the comparisons already shown.",
    ],
    reviewCriteria: [
      "The overview uses ordered stage counts with Started checkout, Added shipping details, Added payment details, Recorded purchase, or equivalent unambiguous wording.",
      "Non-progression bars put transitions on ordered category rows, with an explicit rate measure and preceding-stage denominator; transitions are not legend series.",
      "The month comparison uses months as series and journey-ordered transitions as categories, with separate monthly session populations.",
      "Shipping/payment details are not described as shipment or confirmed payment; missing progression is not proven abandonment.",
      "Rates match their returned numerator/denominator counts, and zero denominators remain undefined rather than 0%.",
      "Interpretation adds no repeated chart when existing visuals adequately cover the findings.",
    ],
  },
  {
    id: "chart-coverage-across-follow-ups",
    questions: [
      "Chart recorded revenue for December 2020 versus January 2021.",
      "Investigate observable contributors to that change and chart their relative changes where useful.",
      "Explain what those findings mean for the business, using the same evidence and comparisons.",
      "Now compare November 2020 with December 2020 instead, including useful charts.",
      "Repeat the revenue comparison chart for November versus December so I can see it here.",
      "Explain the comparison again without any charts.",
    ],
    reviewCriteria: [
      "The contributor follow-up refers to the earlier revenue chart and adds useful new contributor coverage rather than repeating revenue.",
      "Relative-change bars use compatible percentage formats, SQL-derived values and captions identifying periods and non-additivity.",
      "An interpretation-only follow-up adds no charts when prior charts already cover the findings.",
      "Changed periods warrant fresh comparisons; explicit repeat and omit requests are honored.",
      "Narratives are understandable independently and do not claim a primary driver from relative changes alone.",
    ],
  },
  {
    id: "chart-filter-change",
    questions: [
      "Chart session purchase conversion for December 2020 versus January 2021.",
      "Show that comparison for mobile sessions only.",
    ],
    reviewCriteria: ["The mobile follow-up shows a new filtered comparison, rather than treating the all-device chart as coverage of mobile conversion."],
  },
  {
    id: "undefined-change-and-budget",
    questions: [
      "Compare December 2020 and January 2021 purchase revenue and purchase counts for transactions with recorded purchase revenue equal to zero. Chart relative changes where defined, and explain any undefined changes.",
      "Investigate all device, channel, country, product and checkout-stage contributors to the overall December-to-January revenue change. Include useful comparison charts and identify anything the available investigation could not resolve.",
    ],
    reviewCriteria: [
      "Zero or missing baselines produce no fabricated percentage changes; omissions or an alternative visualization are explained.",
      "The broad investigation prioritizes useful evidence within four SQL attempts and reports partial completeness if requested aspects remain unresolved.",
      "Insufficient chart evidence results in supported prose rather than invented values or mismatched units.",
    ],
  },
  {
    id: "scalar-and-comparison",
    questions: [
      "How much revenue did we make in December 2020?",
      "How did it compare with November?",
      "Which devices contributed most to that change?",
    ],
    reviewCriteria: [
      "The scalar answer gives revenue, period, currency and definition concisely.",
      "The comparison uses comparable metrics and reports absolute and percentage changes correctly.",
      "Device contributions compare changes between periods, rather than ranking December totals; disclose any unreconciled totals.",
      "The narrative explains the business meaning and charts support specific findings.",
    ],
  },
  {
    id: "context-and-denominator",
    questions: [
      "What was session purchase conversion in December 2020?",
      "What about mobile only?",
      "What about the previous month?",
    ],
    reviewCriteria: [
      "The session denominator is explicit and numerator and denominator use compatible populations.",
      "Follow-ups preserve the metric and inherit the mobile filter when comparing November.",
    ],
  },
  {
    id: "product-ranking",
    questions: ["What were the top five products by recorded item revenue in January 2021?"],
    reviewCriteria: ["Ranking uses item revenue, discloses excluded identities, and explains the leading finding without unsupported profitability claims."],
  },
  {
    id: "ordered-funnel",
    questions: ["Where did sessions stop progressing through the ordered checkout funnel in December 2020?"],
    reviewCriteria: ["Stages use ordered, compatible session populations; the answer quantifies the largest drop and does not equate missing events with proven abandonment."],
  },
  {
    id: "observable-contributors",
    questions: ["Why did recorded revenue drop in January compared with December? Investigate observable contributors."],
    reviewCriteria: [
      "The analyst verifies the headline change before testing relevant traffic, conversion, purchase value or segment comparisons.",
      "Contributor claims are supported by comparable evidence; an exact decomposition is claimed only when it reconciles.",
      "The narrative explains supported contributors and business implications while separating hypotheses from established observations.",
      "An unfinished explanation is partial and identifies the remaining question; causal uncertainty is disclosed.",
      "Standalone visual coverage considers both the outcome and useful contributor comparisons without a mandatory chart count.",
    ],
  },
  {
    id: "premise-check",
    questions: ["Why did revenue decline from November to December 2020?"],
    reviewCriteria: ["Verify the premise independently against the rows; if revenue did not decline, correct the premise and do not invent reasons for a decline."],
  },
  {
    id: "broad-overview",
    questions: ["Give me an overview of ecommerce performance across November 2020 through January 2021. What deserves attention?"],
    reviewCriteria: [
      "The answer synthesizes relevant metrics and notable changes, with meaningful comparisons and useful visual support.",
      "Suggested areas to investigate follow from evidence; the narrative goes beyond listing metrics or repeating charts.",
    ],
  },
  {
    id: "insufficient-causal-evidence",
    questions: ["Using only this dataset, establish whether a competitor's price cuts caused our January 2021 revenue change compared with December 2020."],
    reviewCriteria: [
      "The answer explains that competitor prices and causal identification are unavailable; it does not fabricate either.",
      "Any reported revenue comparison has real supporting evidence, and the requested causal investigation is marked partial with a specific limitation.",
    ],
  },
];
