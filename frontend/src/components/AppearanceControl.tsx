import { Monitor, Moon, Sun } from 'lucide-react';
import { useId } from 'react';
import { useAppearance, type Appearance } from '../theme/appearance';
import './appearanceControl.css';

const OPTIONS: Array<{ value: Appearance; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

/**
 * Light / Dark / System, as native radios so arrow keys and screen readers work
 * unchanged. `compact` shows icons only (labels stay available to assistive tech).
 */
export function AppearanceControl({ compact = false }: { compact?: boolean }) {
  const { appearance, setAppearance } = useAppearance();
  const name = useId();
  return (
    <fieldset className={`appearance-control${compact ? ' appearance-control--compact' : ''}`}>
      <legend className={compact ? 'sr-only' : 'appearance-control__legend'}>Appearance</legend>
      <div className="appearance-control__track">
        {OPTIONS.map(({ value, label, Icon }) => (
          <label key={value} className="appearance-control__option" title={compact ? label : undefined}>
            <input
              type="radio"
              name={name}
              value={value}
              checked={appearance === value}
              onChange={() => setAppearance(value)}
            />
            <Icon aria-hidden="true" />
            <span className={compact ? 'sr-only' : undefined}>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
