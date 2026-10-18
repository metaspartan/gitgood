import { useId, type ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  size = "sm",
  className,
}: SwitchProps): ReactNode {
  const inputId = useId();
  const hintId = `${inputId}-hint`;

  return (
    <div className="switch-field">
      <div
        className={`switch${size === "sm" ? " switch-sm" : ""}${disabled ? " switch-disabled" : ""}${className ? ` ${className}` : ""}`}
      >
        <input
          id={inputId}
          className="switch-input"
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <label htmlFor={inputId} className="switch-label">
          <span className="switch-track" aria-hidden="true">
            <span className="switch-knob" />
          </span>
          {label}
        </label>
      </div>
      {hint ? (
        <span className="switch-hint faint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
