import { useEffect, useId, useState } from "react";
import { useApi } from "../lib/useApi";

type Member = { id: number; name: string; email: string };
/** Bounded, permission-checked identity search. No numeric ID typing required. */
export function MemberSelect({
  name,
  value,
  onChange,
  label = "Member",
  required = true,
  instructorsOnly = false,
}: {
  name?: string;
  value?: string;
  onChange?: (value: string) => void;
  label?: string;
  required?: boolean;
  instructorsOnly?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState("");
  const [chosen, setChosen] = useState<Member | null>(null);
  const current = value ?? selection;
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const result = useApi<{ items: Member[]; hasMore: boolean }>(
    query.length >= 2
      ? "/training/members?" +
          new URLSearchParams({
            search: query,
            ...(instructorsOnly ? { role: "instructor" } : {}),
          })
      : null,
  );
  const options = [...(result.data?.items ?? [])];
  if (
    chosen &&
    String(chosen.id) === current &&
    !options.some((x) => x.id === chosen.id)
  )
    options.unshift(chosen);
  return (
    <div className="member-select">
      <label htmlFor={id + "-search"}>
        Find {label.toLowerCase()} by name or email
      </label>
      <input
        id={id + "-search"}
        type="search"
        value={search}
        maxLength={100}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(event) => {
          // Refining a search must not submit a parent booking/approval form
          // against a previously selected person.
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        value={current}
        required={required}
        onChange={(e) => {
          const selected = e.target.value;
          setSelection(selected);
          onChange?.(selected);
          setChosen(options.find((x) => String(x.id) === selected) ?? null);
        }}
      >
        <option value="">
          {required ? "Choose " + label.toLowerCase() : "All members"}
        </option>
        {current && !options.some((x) => String(x.id) === current) ? (
          <option value={current}>Current selection — search to change</option>
        ) : null}
        {options.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name} — {person.email}
          </option>
        ))}
      </select>
      {search.trim().length < 2 ? (
        <p>Enter at least two characters to find a person.</p>
      ) : null}
      {result.loading ? <p role="status">Finding people…</p> : null}
      {result.error ? (
        <p role="alert">
          {result.error}{" "}
          <button type="button" onClick={result.reload}>
            Retry search
          </button>
        </p>
      ) : null}
      {result.data?.hasMore ? (
        <p>More matches exist. Refine your search.</p>
      ) : null}
      {result.data && !result.data.items.length ? (
        <p>No matching people.</p>
      ) : null}
    </div>
  );
}
