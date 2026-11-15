// The profile page's photo row: add, change or remove the signed-in person's photo. Staff with a
// member's account open see it but can't change it; the API refuses that too.

import { Camera, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { api, errorMessage } from "../lib/api";
import { encodePhoto, PhotoError, readPhotoFile, rememberPhoto, type Crop, type PhotoSource } from "../lib/profilePhoto";
import { AccountPhoto } from "./AccountPhoto";
import { Modal } from "./Modal";
import { PhotoEditor } from "./PhotoEditor";

const problem = (error: unknown) => (error instanceof PhotoError ? error.message : errorMessage(error));

export function ProfilePhotoSetting({ notify }: { notify: (message: string) => void }) {
  const { user, actor, refresh } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<PhotoSource | null>(null);
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  if (!user) return null;
  const hasPhoto = Boolean(user.photoVersion);
  const ownAccount = !actor || actor.id === user.id;

  const choose = async (file: File | undefined) => {
    // Clear the input so choosing the same file again still opens the editor.
    if (input.current) input.current.value = "";
    if (!file) return;
    setError("");
    try {
      const chosen = await readPhotoFile(file);
      setSaveError("");
      setSource(chosen);
    } catch (err) {
      setError(problem(err));
    }
  };
  const save = async (crop: Crop) => {
    if (!source) return;
    setBusy("save");
    setSaveError("");
    try {
      const image = encodePhoto(source, crop);
      const saved = await api<{ version: string }>("/me/photo", { method: "PUT", body: { image } });
      rememberPhoto({ version: saved.version, image });
      setSource(null);
      notify("Photo saved.");
      await refresh(false, { fresh: true });
    } catch (err) {
      setSaveError(problem(err));
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("remove");
    setError("");
    try {
      await api("/me/photo", { method: "DELETE" });
      notify("Photo removed.");
      await refresh(false, { fresh: true });
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="account-photo">
      <AccountPhoto person={user} className="account-photo__avatar" />
      <div className="account-photo__text">
        <strong>Profile photo</strong>
        <span>
          {!ownAccount
            ? "Members change their own photo."
            : hasPhoto
              ? "Shown on your account instead of your initials."
              : "Add a photo to show on your account instead of your initials."}
        </span>
      </div>
      {ownAccount ? (
        <div className="account-photo__actions">
          <input
            ref={input}
            type="file"
            accept="image/*"
            hidden
            aria-label="Choose a profile photo"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <button type="button" className="button button--quiet" onClick={() => input.current?.click()} disabled={busy !== null}>
            <Camera aria-hidden="true" /> {hasPhoto ? "Change photo" : "Add photo"}
          </button>
          {hasPhoto ? (
            <button type="button" className="button button--quiet" onClick={() => void remove()} disabled={busy !== null}>
              <Trash2 aria-hidden="true" /> {busy === "remove" ? "Removing…" : "Remove"}
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Modal
        open={source !== null}
        title="Position your photo"
        width="compact"
        dismissible={busy !== "save"}
        onClose={() => setSource(null)}
      >
        {source ? (
          <PhotoEditor
            source={source}
            busy={busy === "save"}
            error={saveError}
            onCancel={() => setSource(null)}
            onSave={(crop) => void save(crop)}
          />
        ) : null}
      </Modal>
    </div>
  );
}
