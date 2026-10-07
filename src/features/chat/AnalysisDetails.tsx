import type { Answer } from "../../shared/analysis";
import styles from "./chat.module.css";

export function AnalysisDetails({ answer }: { answer: Answer }) {
  const analysis = answer.analysis;

  return (
    <details className={styles.answerDetails}>
      <summary>Analysis details</summary>
      {analysis && (
        <>
          <p>{analysis.context.question}</p>
          <dl>
            <dt>Period</dt>
            <dd>
              {analysis.context.period
                ? `${analysis.context.period.start} to ${analysis.context.period.end}`
                : "Not applicable or not specified"}
            </dd>
            {analysis.context.comparisonPeriod && (
              <>
                <dt>Comparison</dt>
                <dd>{analysis.context.comparisonPeriod.start} to {analysis.context.comparisonPeriod.end}</dd>
              </>
            )}
            <dt>Population</dt>
            <dd>{analysis.context.population}</dd>
          </dl>
          {analysis.context.filters.length > 0 && (
            <>
              <p>Filters</p>
              <ul>
                {analysis.context.filters.map((filter, index) => <li key={index}>{filter}</li>)}
              </ul>
            </>
          )}
          {analysis.findings.length > 0 && (
            <>
              <p>Findings and supporting evidence</p>
              <ol>
                {analysis.findings.map((finding, index) => (
                  <li key={index}>
                    <strong>{finding.statement}</strong><br />
                    {finding.interpretation}<br />
                    Supporting query results: {finding.evidenceIds.map(id => answer.evidenceIds.indexOf(id) + 1).join(", ")}
                  </li>
                ))}
              </ol>
            </>
          )}
          {analysis.openQuestions.length > 0 && (
            <>
              <p>Remaining questions</p>
              <ul>
                {analysis.openQuestions.map((question, index) => (
                  <li key={index}>
                    {question.question} — {question.canInvestigate ? "Investigable in this dataset" : "Needs additional data"}
                    {question.requiredForAnswer ? "; needed to complete this answer" : "; optional exploration"}
                    {question.obstacle ? `. ${question.obstacle}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {answer.assumptions.length > 0 && (
        <>
          <p>Definitions and assumptions</p>
          <ul>{answer.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </>
      )}
      {answer.limitations.length > 0 && (
        <>
          <p>Limitations</p>
          <ul>{answer.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </>
      )}
    </details>
  );
}
