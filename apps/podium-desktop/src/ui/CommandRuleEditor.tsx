import type { AgentCommandRule } from "./types";

export function CommandRuleEditor({ legend, addLabel, rules, onChange }: { legend: string; addLabel: string; rules: AgentCommandRule[]; onChange: (rules: AgentCommandRule[]) => void }) {
  const updateRule = (index: number, rule: AgentCommandRule) =>
    onChange(rules.map((current, currentIndex) => currentIndex === index ? rule : current));
  return (
    <fieldset className="command-rules">
      <legend>{legend}</legend>
      {rules.map((rule, ruleIndex) => (
        <div className="command-rule" key={ruleIndex}>
          <label>Executable<input required aria-label={`${legend} executable ${ruleIndex + 1}`} value={rule.executable} onChange={(event) => updateRule(ruleIndex, { ...rule, executable: event.target.value })} /></label>
          {rule.argvPrefix.map((argument, argumentIndex) => (
            <div className="command-argument" key={argumentIndex}>
              <label>Argument {argumentIndex + 1}<input required aria-label={`${legend} rule ${ruleIndex + 1} argument ${argumentIndex + 1}`} value={argument} onChange={(event) => updateRule(ruleIndex, { ...rule, argvPrefix: rule.argvPrefix.map((current, currentIndex) => currentIndex === argumentIndex ? event.target.value : current) })} /></label>
              <button className="button compact" type="button" aria-label={`Remove ${legend.toLowerCase()} argument ${argumentIndex + 1}`} onClick={() => updateRule(ruleIndex, { ...rule, argvPrefix: rule.argvPrefix.filter((_, currentIndex) => currentIndex !== argumentIndex) })}>Remove</button>
            </div>
          ))}
          <div className="button-row command-rule-actions">
            <button className="button compact" type="button" disabled={rule.argvPrefix.length >= 16} onClick={() => updateRule(ruleIndex, { ...rule, argvPrefix: [...rule.argvPrefix, ""] })}>Add argument</button>
            <button className="button compact" type="button" onClick={() => onChange(rules.filter((_, currentIndex) => currentIndex !== ruleIndex))}>Remove rule</button>
          </div>
        </div>
      ))}
      <button className="button compact" type="button" disabled={rules.length >= 64} onClick={() => onChange([...rules, { executable: "", argvPrefix: [] }])}>{addLabel}</button>
    </fieldset>
  );
}
