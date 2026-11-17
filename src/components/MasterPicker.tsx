"use client";
import { useState, type CSSProperties } from "react";
import { MasterLookup, type AddTarget, type LookupOption } from "./MasterLookup";

/**
 * Uncontrolled master-data combobox for plain <form>s (server pages and server actions).
 * Posts its value through a hidden input called `name`, like a <select> would.
 * `valueIsCode`: the field stores the record code, so a newly added record fills in its code.
 */
export function MasterPicker({ name, options, defaultValue, add, required, emptyLabel, placeholder, valueIsCode, ariaLabel, style, disabled }: {
  name: string; options: LookupOption[]; defaultValue?: string | null; add?: AddTarget | AddTarget[]; required?: boolean;
  emptyLabel?: string; placeholder?: string; valueIsCode?: boolean; ariaLabel?: string; style?: CSSProperties; disabled?: boolean;
}) {
  const [v, setV] = useState(defaultValue ?? "");
  const targets = add ? (Array.isArray(add) ? add : [add]) : undefined;
  // Keep a saved code that is no longer in the list visible instead of showing a blank field.
  const opts = valueIsCode && defaultValue && !options.some((o) => o.value === defaultValue)
    ? [...options, { value: defaultValue, code: defaultValue, label: "(not in the list)" }] : options;
  return (
    <MasterLookup name={name} options={opts} value={v} required={required} emptyLabel={emptyLabel} placeholder={placeholder} disabled={disabled}
      add={targets && valueIsCode ? targets.map((t) => ({ ...t, toValue: (r) => r.code })) : targets}
      onChange={(x) => setV(x)} ariaLabel={ariaLabel ?? name} style={style} />
  );
}
