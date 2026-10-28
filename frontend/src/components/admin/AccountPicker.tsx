import { History, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { errorMessage } from "../../lib/api";
import type { Page, Person } from "../../lib/staffContracts";
import { useApi } from "../../lib/useApi";
import { Modal } from "../Modal";
import {
  initials,
  isProtectedAccount,
  recentAccounts,
  rememberAccount,
  roleLabel,
  type RecentAccount,
} from "./people";

/** Why a search result can't be opened, or null when it can. */
function unavailable(person: Person, selfId: number | undefined) {
  if (person.id === selfId) return null;
  if (isProtectedAccount(person)) return "Staff account";
  if (person.status !== "active") return "Suspended";
  if (person.accessStatus !== "active") return "Restricted";
  return null;
}

/** Choose whose account to open on the member site. */
export function AccountPicker({ onClose }: { onClose: () => void }) {
  const { user, actor, openAccount } = useAuth();
  const staff = actor ?? user;
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [recent] = useState(recentAccounts);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(input.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [input]);
  const results = useApi<Page<Person>>(
    search.length >= 2 ? `/admin/users?search=${encodeURIComponent(search)}&offset=0` : null,
  );

  const open = async (account: RecentAccount) => {
    setBusy(account.id);
    setError("");
    try {
      await openAccount(account.id);
      if (account.id !== staff?.id) rememberAccount(account);
      onClose();
      navigate("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  const row = (account: RecentAccount, detail: string, tag?: { text: string; tone: string }, blocked?: string | null) => (
    <li key={account.id}>
      <button
        type="button"
        className="account-picker__row"
        onClick={() => void open(account)}
        disabled={busy !== null || !!blocked}
        aria-describedby={blocked ? `account-blocked-${account.id}` : undefined}
      >
        <span className={`admin-avatar admin-avatar--${account.id % 5}`} aria-hidden="true">
          {initials(account.firstName, account.lastName)}
        </span>
        <span className="account-picker__who">
          <strong>
            {account.id === staff?.id ? "Your own account" : `${account.firstName} ${account.lastName}`}
          </strong>
          <span>{busy === account.id ? "Opening…" : detail}</span>
        </span>
        {blocked ? (
          <span id={`account-blocked-${account.id}`} className="status-pill status-pill--neutral">
            {blocked}
          </span>
        ) : tag ? (
          <span className={`status-pill status-pill--${tag.tone}`}>{tag.text}</span>
        ) : null}
      </button>
    </li>
  );

  const items = results.data?.items.slice(0, 8) ?? [];
  return (
    <Modal open title="Whose account?" onClose={onClose}>
      <div className="account-picker">
        <p className="account-picker__intro">
          You'll see the member site the way they do, and can book, sign up and check in for them.
        </p>
        <label className="account-picker__search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Search members by name or email"
            aria-label="Search members by name or email"
            maxLength={100}
            autoFocus
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {search.length >= 2 ? (
          <section aria-label="Search results">
            {results.loading && !results.data ? <p className="account-picker__hint" role="status">Searching…</p> : null}
            {results.error ? <p className="form-error" role="alert">{results.error}</p> : null}
            {results.data && !items.length ? (
              <p className="account-picker__hint">No members match “{search}”.</p>
            ) : null}
            <ul className="account-picker__list">
              {items.map((person) =>
                row(person, person.email, { text: roleLabel(person), tone: "neutral" }, unavailable(person, staff?.id)),
              )}
            </ul>
          </section>
        ) : (
          <>
            {staff ? (
              <section aria-labelledby="account-picker-you">
                <h3 id="account-picker-you" className="account-picker__label">You</h3>
                <ul className="account-picker__list">
                  {row(staff, `${staff.firstName} ${staff.lastName}`, { text: roleLabel(staff), tone: "neutral" })}
                </ul>
              </section>
            ) : null}
            {recent.length ? (
              <section aria-labelledby="account-picker-recent">
                <h3 id="account-picker-recent" className="account-picker__label">Recent</h3>
                <ul className="account-picker__list">
                  {recent.map((account) => row(account, "Opened recently"))}
                </ul>
              </section>
            ) : (
              <p className="account-picker__hint">Type at least two letters of a name or email.</p>
            )}
          </>
        )}
        <p className="account-picker__note">
          <History aria-hidden="true" />
          Everything you do in their account is logged under your name.
        </p>
      </div>
    </Modal>
  );
}
