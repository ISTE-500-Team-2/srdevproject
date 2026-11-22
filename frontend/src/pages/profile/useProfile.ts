// Loads the member's profile and saves section changes one after another, each built on the last response.

import { useEffect, useRef, useState } from "react";
import type { useAuth } from "../../context/AuthContext";
import { api, errorMessage } from "../../lib/api";
import type { UserProfile } from "../../lib/contracts";
import type { Save } from "./fields";

export function useProfile(refresh: ReturnType<typeof useAuth>["refresh"]) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const latestProfile = useRef<UserProfile | null>(null);
  const saveQueue = useRef(Promise.resolve());
  const active = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  // Email links land on a section (e.g. #minors); scroll once the profile has laid out.
  const landed = useRef(false);
  useEffect(() => {
    if (!profile || landed.current) return;
    landed.current = true;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [profile]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<UserProfile>("/me/profile", { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        latestProfile.current = loaded;
        setProfile(loaded);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [attempt]);
  const updateProfile = (change: Partial<UserProfile>) => {
    if (!latestProfile.current) return;
    latestProfile.current = { ...latestProfile.current, ...change };
    setProfile(latestProfile.current);
  };
  // Sections can save together, but the API replaces all identity fields.
  // Build each request from the preceding response, never a render's snapshot.
  const save: Save = (change) => {
    const request = saveQueue.current.then(async () => {
      if (!active.current) return;
      const stored = latestProfile.current;
      if (!stored) throw new Error("Your profile is still loading. Try again.");
      setToast(null);
      const saved = await api<UserProfile>("/me/profile", {
        method: "PATCH",
        body: {
          firstName: change.firstName ?? stored.user.firstName,
          lastName: change.lastName ?? stored.user.lastName,
          phone: change.phone ?? stored.user.phone,
          address: change.address ?? stored.address,
          contactPreferences: change.contactPreferences ?? stored.contactPreferences,
        },
      });
      if (!active.current) return;
      latestProfile.current = saved;
      setProfile(saved);
      setToast("Changes saved.");
      await refresh(false, { fresh: true });
    });
    // One failed section must not prevent another queued section from saving.
    saveQueue.current = request.catch(() => {});
    return request;
  };
  return { profile, toast, setToast, error, setError, setAttempt, updateProfile, save };
}
