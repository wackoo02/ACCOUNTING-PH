"use client";
import { useState } from "react";
import { MasterLookup, type AddTarget, type LookupOption } from "@/components/MasterLookup";

/** Uncontrolled wrapper so server-rendered debt forms can use the shared master-data picker. */
export function Picker({ name, options, defaultValue, add, required, emptyLabel, placeholder, valueIsCode }: {
  name: string; options: LookupOption[]; defaultValue?: string | null; add?: AddTarget; required?: boolean; emptyLabel?: string; placeholder?: string; valueIsCode?: boolean;
}) {
  const [v, setV] = useState(defaultValue ?? "");
  return <MasterLookup name={name} options={options} value={v} required={required} emptyLabel={emptyLabel} placeholder={placeholder}
    add={add && valueIsCode ? { ...add, toValue: (r) => r.code } : add} onChange={(x) => setV(x)} ariaLabel={name} />;
}
