import { Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useApi } from "../lib/useApi";

type Member = { id: number; name: string; email: string };

/**
 * The one way staff pick a person: type a name or email, choose from the
 * matches, and see who's picked. Submits the person's id under `name`.
 * Bounded, permission-checked search; nobody types numeric IDs.
 */
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
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [selection, setSelection] = useState("");
  const [chosen, setChosen] = useState<Member | null>(null);
  const current = value ?? selection;
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  // A parent clearing the value (e.g. after saving) clears the picked person.
  useEffect(() => {
    if (!current) setChosen(null);
  }, [current]);
  const result = useApi<{ items: Member[]; hasMore: boolean }>(
    query.length >= 2
      ? "/training/members?" +
          new URLSearchParams({
            search: query,
            ...(instructorsOnly ? { role: "instructor" } : {}),
          })
      : null,
  );
  const options = result.data?.items ?? [];
  // Typed text that wasn't turned into a pick must not pass as a choice.
  useEffect(() => {
    input.current?.setCustomValidity(
      !current && search.trim() ? `Choose ${label.toLowerCase()} from the list.` : "",
    );
  }, [current, search, label]);

  const pick = (person: Member) => {
    setChosen(person);
    setSelection(String(person.id));
    onChange?.(String(person.id));
    setSearch("");
    setOpen(false);
  };
  const clear = () => {
    setChosen(null);
    setSelection("");
    onChange?.("");
    setOpen(true);
    window.setTimeout(() => input.current?.focus());
  };
  const listId = id + "-list";
  const showList = open && query.length >= 2 && search.trim().length >= 2;

  return (
    <div className="member-select">
      {current ? (
        <span className="member-select__label" id={id + "-label"}>
          {label}
        </span>
      ) : (
        <label className="member-select__label" htmlFor={id}>
          {label}
        </label>
      )}
      {current ? (
        <div className="member-select__chosen" role="group" aria-labelledby={id + "-label"}>
          <span>
            <b>{chosen?.name ?? `${label} #${current}`}</b>
            {chosen ? <small>{chosen.email}</small> : null}
          </span>
          <button type="button" className="member-select__change" onClick={clear} aria-label={`Change ${label.toLowerCase()}`}>
            <X aria-hidden="true" /> Change
          </button>
          {name ? <input type="hidden" name={name} value={current} /> : null}
        </div>
      ) : (
        <div className="member-select__field">
          <Search aria-hidden="true" />
          <input
            ref={input}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList && options[active] ? `${listId}-${options[active].id}` : undefined}
            autoComplete="off"
            placeholder="Search by name or email"
            value={search}
            maxLength={100}
            required={required}
            onChange={(e) => {
              setSearch(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (event.key === "Enter") {
                // Never submit a parent form against a half-typed search.
                event.preventDefault();
                if (showList && options[active]) pick(options[active]);
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {/* Keeps the field in the form (empty) when nobody is picked. */}
          {name ? <input type="hidden" name={name} value="" /> : null}
        </div>
      )}
      {!current && showList ? (
        <ul id={listId} role="listbox" aria-label={`${label} matches`} className="member-select__list">
          {options.map((person, i) => (
            <li
              key={person.id}
              id={`${listId}-${person.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "is-active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(person);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <b>{person.name}</b>
              <small>{person.email}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {!current ? (
        <div className="member-select__status">
          {search.trim().length > 0 && search.trim().length < 2 ? <p>Type at least two letters.</p> : null}
          {result.loading ? <p role="status">Finding people…</p> : null}
          {result.error ? (
            <p role="alert">
              {result.error}{" "}
              <button type="button" onClick={result.reload}>
                Retry search
              </button>
            </p>
          ) : null}
          {search.trim().length >= 2 && result.data?.hasMore ? <p>More matches exist. Refine your search.</p> : null}
          {search.trim().length >= 2 && result.data && !result.data.items.length ? <p>No matching people.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
