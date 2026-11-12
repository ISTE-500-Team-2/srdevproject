import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../lib/useApi";
import type { Person } from "../lib/staffContracts";
import type { ReaderSetup } from "../lib/nfc";
import { LoadState } from "../components/Management";
import { MemberSelect } from "../components/MemberSelect";
import { AccessReadiness } from "../components/staff/AccessReadiness";
import { MemberCards } from "../components/access/MemberCards";
import { ReaderManager } from "../components/access/ReaderManager";
import { CardLookup } from "../components/access/CardLookup";
import { TapHistory } from "../components/access/TapHistory";
import { RecentTaps } from "../components/access/RecentTaps";

export function AccessManagementPage() {
  const [params, setParams] = useSearchParams();
  const requested = Number(params.get("member"));
  const member =
    Number.isSafeInteger(requested) && requested > 0 ? String(requested) : "";
  const view = ["readers", "lookup", "history"].includes(
    params.get("view") ?? "",
  )
    ? params.get("view")!
    : "cards";
  const requestedTap = Number(params.get("tap"));
  const tap =
    Number.isSafeInteger(requestedTap) && requestedTap > 0
      ? requestedTap
      : undefined;
  const detail = useApi<{ user: Person }>(
    member ? `/admin/users/${member}` : null,
  );
  const setup = useApi<ReaderSetup>("/admin/access/readers", {
    retainOnReload: true,
  });
  const person =
    detail.data?.user.id === Number(member) ? detail.data.user : undefined;
  return (
    <section className="management-page nfc-page">
      <header className="admin-page-heading">
        <p className="admin-page-eyebrow">Operations</p>
        <h1 className="admin-title">Reader access</h1>
        <p>Assign NFC cards, manage readers, and investigate card taps.</p>
      </header>
      <nav className="nfc-nav" aria-label="Reader access sections">
        {[
          ["cards", "Member cards"],
          ["readers", "Readers"],
          ["lookup", "Find a card"],
          ["history", "Tap history"],
        ].map(([key, label]) => (
          <Link
            key={key}
            aria-current={view === key ? "page" : undefined}
            to={`?${new URLSearchParams({ ...(view === "cards" && member ? { member } : {}), ...(key === "cards" ? {} : { view: key }) })}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {view === "cards" ? (
        <>
          <MemberSelect
            name="member"
            value={member}
            selectedMember={
              person
                ? {
                    id: person.id,
                    name: `${person.firstName} ${person.lastName}`,
                    email: person.email,
                  }
                : undefined
            }
            onChange={(value) => setParams(value ? { member: value } : {})}
            description="Find a member to view or assign their NFC cards."
            autoFocus={finePointer()}
          />
          {member ? (
            <>
              <LoadState {...detail} />
              {detail.error ? (
                <button
                  className="button button--quiet"
                  onClick={detail.reload}
                >
                  Retry member
                </button>
              ) : null}
              {person ? (
                <MemberWorkspace key={person.id} person={person} />
              ) : null}
            </>
          ) : (
            <RecentTaps timeZone={setup.data?.timeZone} />
          )}
        </>
      ) : (
        <>
          <LoadState {...setup} />
          {setup.error ? (
            <button className="button button--quiet" onClick={setup.reload}>
              Retry reader setup
            </button>
          ) : null}
          {setup.data ? (
            view === "readers" ? (
              <ReaderManager
                setup={setup.data}
                reload={setup.reload}
                refreshing={setup.refreshing}
              />
            ) : view === "lookup" ? (
              <CardLookup key={tap} setup={setup.data} tapId={tap} />
            ) : (
              <TapHistory setup={setup.data} />
            )
          ) : null}
        </>
      )}
    </section>
  );
}
/** Typing straight away suits a desk; on touch screens the keyboard would hide the page. */
function finePointer() {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: fine)").matches
    : false;
}
function MemberWorkspace({ person }: { person: Person }) {
  const [revision, setRevision] = useState(0);
  return (
    <>
      <MemberCards
        userId={person.id}
        memberName={`${person.firstName} ${person.lastName}`}
        onChanged={() => setRevision((n) => n + 1)}
      />
      <AccessReadiness userId={person.id} revision={revision} />
      <p className="nfc-help">
        Supervised equipment and room access is managed in{" "}
        <Link to={`/admin/members?member=${person.id}`}>
          {person.firstName}’s member record
        </Link>
        .
      </p>
    </>
  );
}
