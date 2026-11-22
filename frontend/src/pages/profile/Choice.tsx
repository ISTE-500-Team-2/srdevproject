import { type LucideIcon } from "lucide-react";
import { useState } from "react";

export function Choice({
  name,
  label,
  options,
  value,
}: {
  name: string;
  label: string;
  options: { value: string; Icon?: LucideIcon }[];
  value: string;
}) {
  const [picked, setPicked] = useState(value);
  // Older profiles allowed free text. Keep that saved choice until the member
  // deliberately selects one of the newer options.
  const choices: typeof options = value && !options.some((option) => option.value === value)
    ? [{ value }, ...options]
    : options;
  return (
    <fieldset className="account-choice">
      <legend>{label}</legend>
      <div className="account-choice__options">
        {choices.map(({ value: option, Icon }) => (
          <label key={option} className={picked === option ? "is-on" : ""}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={picked === option}
              onChange={() => setPicked(option)}
            />
            {Icon ? <Icon aria-hidden="true" /> : null}
            {option}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
